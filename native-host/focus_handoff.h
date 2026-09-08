#ifndef AGENT_BROWSER_FOCUS_HANDOFF_H_
#define AGENT_BROWSER_FOCUS_HANDOFF_H_

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cwchar>
#include <memory>
#include <new>
#include <string>

namespace ab_focus {

// One output owner calls SetDeadline and the five command methods. The input
// owner may concurrently call Revoke (current handoff) or SignalCancel (EOF).
// SignalCancel permanently revokes this object, including all future Begin calls.
// The caller binds its exact Chrome owner/tab/window before Commit and checks
// that joint binding afterward. Class name alone is NOT task authority.
// WHY: end-state HWND equality misses away-and-back and recycled windows.
// Hooks/process handles therefore cover the complete handoff, not just acquire.
// WHY: the real native SetForegroundWindow call returned zero and Chrome
// remained foreground. Chrome's documented windows.update({focused:false})
// delegates to its own Deactivate, which selects the next visible HWND. Only
// allow that cooperative release when that exact HWND is the saved prior app.
// Never reorder windows or bypass foreground permissions. No OS focus-CAS or
// revocation of already submitted Chrome activation exists: report uncertainty.
class Handoff final {
 private:
  enum class Status {
    Captured, Armed, Unchanged, Prepared, Returned, AlreadyCurrent,
    Cancelled, Denied, Unavailable, Unconfirmed
  };
  enum class Command { Commit, Check, Release, FinishRelease };
  enum class Phase { Capturing, Captured, Armed, Returning, Cancelled };
  enum class Gate { Open, Cancelled, Submitted };

  static std::uint64_t UnixMs() {
    FILETIME now{};
    GetSystemTimeAsFileTime(&now);
    const std::uint64_t ticks =
        (static_cast<std::uint64_t>(now.dwHighDateTime) << 32U) |
        static_cast<std::uint64_t>(now.dwLowDateTime);
    constexpr std::uint64_t epoch = 116444736000000000ULL;
    return ticks >= epoch ? (ticks - epoch) / 10000ULL : 0ULL;
  }

  struct Deadline {
    std::uint64_t unix_ms = 0;
    std::uint64_t tick_ms = 0;
    static Deadline From(std::uint64_t absolute) {
      const std::uint64_t now = UnixMs();
      const std::uint64_t budget = absolute > now
          ? (std::min)(absolute - now, std::uint64_t{2500}) : 0;
      return {absolute, GetTickCount64() + budget};
    }
    DWORD Remaining() const {
      const std::uint64_t unix_now = UnixMs();
      const std::uint64_t tick_now = GetTickCount64();
      if (unix_now == 0 || unix_now >= unix_ms || tick_now >= tick_ms) return 0;
      return static_cast<DWORD>((std::min)(
          (std::min)(unix_ms - unix_now, tick_ms - tick_now),
          std::uint64_t{2500}));
    }
  };

  struct Window {
    HWND hwnd = nullptr;
    DWORD pid = 0;
    DWORD tid = 0;
    HANDLE process = nullptr;
    FILETIME birth{};
    void Clear() {
      if (process != nullptr) CloseHandle(process);
      process = nullptr;
      hwnd = nullptr;
    }
    bool Capture(HWND value) {
      Clear();
      if (value == nullptr || !IsWindow(value)) return false;
      hwnd = value;
      tid = GetWindowThreadProcessId(hwnd, &pid);
      if (tid == 0 || pid == 0) return false;
      process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                            FALSE, pid);
      FILETIME exit{}, kernel{}, user{};
      return process != nullptr &&
             GetProcessTimes(process, &birth, &exit, &kernel, &user) && Valid();
    }
    bool Valid() const {
      if (process == nullptr || !IsWindow(hwnd) ||
          WaitForSingleObject(process, 0) != WAIT_TIMEOUT ||
          GetProcessId(process) != pid) return false;
      DWORD current_pid = 0;
      if (GetWindowThreadProcessId(hwnd, &current_pid) != tid ||
          current_pid != pid) return false;
      FILETIME current_birth{}, exit{}, kernel{}, user{};
      return GetProcessTimes(process, &current_birth, &exit, &kernel, &user) &&
             CompareFileTime(&birth, &current_birth) == 0;
    }
  };

  // Both caller and worker retain this state. A bounded caller/destructor may
  // leave before an OS call returns; neither handles nor callback memory are
  // freed until the worker finishes. Only the hook thread ever unhooks.
  struct State {
    HANDLE worker = nullptr;
    HANDLE request = nullptr;
    HANDLE completed = nullptr;
    std::atomic<bool> cancel{false};
    std::atomic<bool> active{true};
    std::atomic<bool> finished{false};
    std::atomic<Gate> gate{Gate::Open};
    std::atomic<Status> result{Status::Unavailable};
    std::atomic<const char*> reason{"NONE"};
    std::atomic<Command> command{Command::Check};
    std::atomic<std::uint64_t> request_unix{0};
    std::atomic<std::uint64_t> request_tick{0};
    // The remaining fields belong exclusively to the hook/message thread.
    Deadline deadline;
    Phase phase = Phase::Capturing;
    HWINEVENTHOOK foreground_hook = nullptr;
    HWINEVENTHOOK destroy_hook = nullptr;
    Window prior;
    Window target;
    HWND transition = nullptr;
    inline static thread_local State* local = nullptr;

    ~State() {
      prior.Clear();
      target.Clear();
      if (worker != nullptr) CloseHandle(worker);
      if (request != nullptr) CloseHandle(request);
      if (completed != nullptr) CloseHandle(completed);
    }
    void Revoke() {
      Gate expected = Gate::Open;
      gate.compare_exchange_strong(expected, Gate::Cancelled);
      cancel.store(true);
      if (request != nullptr) SetEvent(request);
    }
    Status CancelStatus() const {
      return gate.load() == Gate::Submitted ? Status::Unconfirmed
                                            : Status::Cancelled;
    }
    void SetRequest(Command value, Deadline limit) {
      ResetEvent(completed);
      request_unix.store(limit.unix_ms);
      request_tick.store(limit.tick_ms);
      command.store(value);
      if (!SetEvent(request)) Revoke();
    }
    static DWORD WINAPI Entry(void* context) {
      auto* retained = static_cast<std::shared_ptr<State>*>(context);
      std::shared_ptr<State> self = std::move(*retained);
      delete retained;
      local = self.get();
      self->Run();
      local = nullptr;
      return 0;
    }
    static void CALLBACK Event(HWINEVENTHOOK, DWORD event, HWND hwnd,
                               LONG object, LONG child, DWORD, DWORD) {
      if (local == nullptr) return;
      State& s = *local;
      if (event == EVENT_OBJECT_DESTROY) {
        if (object == OBJID_WINDOW && child == CHILDID_SELF && hwnd != nullptr &&
            (hwnd == s.prior.hwnd || hwnd == s.target.hwnd ||
             hwnd == s.transition)) s.phase = Phase::Cancelled;
        return;
      }
      if (event != EVENT_SYSTEM_FOREGROUND) return;
      if (s.phase == Phase::Capturing || hwnd == nullptr) {
        s.phase = Phase::Cancelled;
      } else if (s.phase == Phase::Captured) {
        if (hwnd == s.prior.hwnd) {
          if (s.transition != nullptr) s.phase = Phase::Cancelled;
        } else if (s.transition == nullptr) {
          s.transition = hwnd;
        } else if (hwnd != s.transition) {
          s.phase = Phase::Cancelled;
        }
      } else if (s.phase == Phase::Armed && hwnd != s.target.hwnd) {
        s.phase = Phase::Cancelled;
      } else if (s.phase == Phase::Returning &&
                 hwnd != s.target.hwnd && hwnd != s.prior.hwnd) {
        s.phase = Phase::Cancelled;
      }
    }
    bool Drain() {
      MSG message{};
      for (unsigned count = 0; count < 256; ++count) {
        if (cancel.load()) return false;
        if (!PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
          return phase != Phase::Cancelled;
        if (message.message == WM_QUIT) break;
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
      phase = Phase::Cancelled;
      return false;
    }
    bool Reconcile() {
      // Owner-local evidence: a generic cancelled response previously hid
      // whether native activation was unsettled or a real independent change.
      if (deadline.Remaining() == 0) { reason.store("DEADLINE"); return false; }
      if (!Drain()) { reason.store("EVENT_CANCELLED"); return false; }
      if (!prior.Valid()) { reason.store("PRIOR_INVALID"); return false; }
      const HWND current = GetForegroundWindow();
      const bool binding = phase == Phase::Captured
          ? current == (transition != nullptr ? transition : prior.hwnd)
          : phase == Phase::Armed && target.Valid() && current == target.hwnd;
      if (!binding) reason.store(phase == Phase::Captured
          ? (current == prior.hwnd ? "CAPTURE_STILL_PRIOR" : "CAPTURE_OTHER_WINDOW")
          : "ARMED_BINDING_CHANGED");
      return binding && !cancel.load() && deadline.Remaining() != 0;
    }
    bool ObserveActivation() {
      // WHY: the installed two-tab replay returned CAPTURE_STILL_PRIOR after
      // Chrome confirmed activation. SetForegroundWindow's cross-input-queue
      // activation is asynchronous (Microsoft, Old New Thing, 2016-11-18).
      // Await only that already-observed transition; never activate again or
      // accept a second window/away-and-back. The original event latch remains.
      const std::uint64_t until = GetTickCount64() + 500ULL;
      for (;;) {
        if (cancel.load() || deadline.Remaining() == 0 || !Drain() ||
            phase != Phase::Captured || !prior.Valid()) return false;
        if (transition == nullptr || GetForegroundWindow() != prior.hwnd)
          return Reconcile();
        if (GetTickCount64() >= until) {
          reason.store("ACTIVATION_SETTLE_TIMEOUT");
          return false;
        }
        const HANDLE waits[] = {request, prior.process};
        const DWORD wait = MsgWaitForMultipleObjectsEx(
            2, waits, (std::min)(DWORD{10}, deadline.Remaining()),
            QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        if (wait != WAIT_TIMEOUT && wait != WAIT_OBJECT_0 + 2) return false;
      }
    }
    Status Commit() {
      if (phase != Phase::Captured) { reason.store("CAPTURE_PHASE_CHANGED"); return CancelStatus(); }
      if (!Reconcile()) return CancelStatus();
      const HWND current = GetForegroundWindow();
      wchar_t class_name[64]{};
      if (!target.Capture(current) ||
          GetClassNameW(current, class_name, 64) == 0 ||
          std::wcscmp(class_name, L"Chrome_WidgetWin_1") != 0)
        return Status::Unavailable;
      if (!Reconcile() || GetForegroundWindow() != current || !target.Valid())
        return CancelStatus();
      phase = Phase::Armed;
      return Status::Armed;
    }
    Status Release() {
      if (phase != Phase::Armed || !Reconcile()) return CancelStatus();
      if (prior.hwnd == target.hwnd) return Status::AlreadyCurrent;
      // Match Chromium HWNDMessageHandler::Deactivate's selection exactly;
      // a missing/different successor is not permission to select another app.
      HWND next = GetWindow(target.hwnd, GW_HWNDNEXT);
      unsigned count = 0;
      while (next != nullptr && !IsWindowVisible(next) && count++ < 256)
        next = GetWindow(next, GW_HWNDNEXT);
      if (next != prior.hwnd || !Reconcile() || !prior.Valid())
        return Status::Unavailable;
      Gate expected = Gate::Open;
      if (!gate.compare_exchange_strong(expected, Gate::Submitted))
        return CancelStatus();
      // Last cooperative check after winning dispatch. If timeout/revocation
      // raced with the fence, conservatively report unconfirmed WITHOUT calling.
      // The few instructions between this check and user32 are not an OS CAS.
      if (cancel.load() || deadline.Remaining() == 0)
        return Status::Unconfirmed;
      phase = Phase::Returning;
      return Status::Prepared;
    }
    Status FinishRelease() {
      if (phase != Phase::Returning) return Status::Unconfirmed;
      const std::uint64_t observe_end = GetTickCount64() + 500ULL;
      for (;;) {
        if (deadline.Remaining() == 0 || !Drain() ||
            !prior.Valid() || !target.Valid()) return Status::Unconfirmed;
        if (GetForegroundWindow() == prior.hwnd) return Status::Returned;
        const std::uint64_t now = GetTickCount64();
        if (now >= observe_end) return Status::Unconfirmed;
        const DWORD remaining = (std::min)(deadline.Remaining(),
            static_cast<DWORD>(observe_end - now));
        if (remaining == 0) return Status::Unconfirmed;
        const HANDLE waits[] = {request, prior.process, target.process};
        const DWORD wait = MsgWaitForMultipleObjectsEx(
            3, waits, remaining, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        if (wait != WAIT_OBJECT_0 + 3) return Status::Unconfirmed;
      }
    }
    void Complete(Status status) {
      result.store(status);
      active.store(false);
      SetEvent(completed);
    }
    void Finish(Status status) {
      // Never claim cancellation after the dispatch fence. There is no API to
      // retract user32's asynchronously submitted activation notification.
      if (status == Status::Cancelled) status = CancelStatus();
      if (foreground_hook != nullptr) UnhookWinEvent(foreground_hook);
      if (destroy_hook != nullptr) UnhookWinEvent(destroy_hook);
      foreground_hook = destroy_hook = nullptr;
      prior.Clear();
      target.Clear();
      result.store(status);
      active.store(false);
      finished.store(true);
      SetEvent(completed);
    }
    void Run() {
      if (cancel.load() || deadline.Remaining() == 0) {
        Finish(Status::Cancelled);
        return;
      }
      MSG message{};
      PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
      foreground_hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND,
          EVENT_SYSTEM_FOREGROUND, nullptr, Event, 0, 0, WINEVENT_OUTOFCONTEXT);
      destroy_hook = SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY,
          nullptr, Event, 0, 0, WINEVENT_OUTOFCONTEXT);
      if (foreground_hook == nullptr || destroy_hook == nullptr ||
          !prior.Capture(GetForegroundWindow())) {
        Finish(Status::Unavailable);
        return;
      }
      if (!Drain() || !prior.Valid() || GetForegroundWindow() != prior.hwnd ||
          deadline.Remaining() == 0) {
        Finish(Status::Cancelled);
        return;
      }
      phase = Phase::Captured;
      Complete(Status::Captured);
      for (;;) {
        if (cancel.load()) {
          Finish(Status::Cancelled);
          return;
        }
        HANDLE waits[] = {request, prior.process, target.process};
        const DWORD count = target.process == nullptr ? 2U : 3U;
        // Idle manual-input observation has no TTL. This wait is not the output
        // pump: Revoke wakes it, and process/window death retires it without input.
        const DWORD wait = MsgWaitForMultipleObjectsEx(
            count, waits, INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        if (wait == WAIT_OBJECT_0) {
          const Command value = command.load();
          deadline = {request_unix.load(), request_tick.load()};
          if (value == Command::FinishRelease) {
            Finish(FinishRelease());
            return;
          }
          if (cancel.load() || !(value == Command::Commit ? ObserveActivation() : Reconcile())) {
            Finish(Status::Cancelled);
            return;
          }
          Status status = Status::Unchanged;
          if (value == Command::Commit) status = Commit();
          if (value == Command::Release) status = Release();
          if (status != Status::Armed && status != Status::Unchanged && status != Status::Prepared) {
            Finish(status);
            return;
          }
          Complete(status);
        } else if (wait == WAIT_OBJECT_0 + count) {
          if (!Drain()) {
            Finish(Status::Cancelled);
            return;
          }
        } else {
          Finish(wait == WAIT_FAILED ? Status::Unavailable : Status::Cancelled);
          return;
        }
      }
    }
  };

  static const char* Name(Status value) {
    switch (value) {
      case Status::Captured: return "captured";
      case Status::Armed: return "armed";
      case Status::Unchanged: return "unchanged";
      case Status::Prepared: return "prepared";
      case Status::Returned: return "returned";
      case Status::AlreadyCurrent: return "already-current";
      case Status::Cancelled: return "cancelled";
      case Status::Denied: return "denied";
      case Status::Unconfirmed: return "unconfirmed";
      default: return "unavailable";
    }
  }
  static std::string Await(const std::shared_ptr<State>& s, Deadline limit) {
    const DWORD remaining = limit.Remaining();
    const HANDLE waits[] = {s->completed, s->worker};
    const DWORD wait = remaining != 0
        ? WaitForMultipleObjects(2, waits, FALSE, remaining) : WAIT_TIMEOUT;
    if (wait == WAIT_OBJECT_0 || wait == WAIT_OBJECT_0 + 1)
      return Name(s->result.load());
    s->Revoke();
    return Name(s->CancelStatus());
  }
  std::string Request(Command command) {
    const auto s = state_.load();
    if (!s) return transport_dead_.load() ? "cancelled" : "unavailable";
    if (s->finished.load()) return Name(s->result.load());
    if (transport_dead_.load() || s->cancel.load()) return Name(s->CancelStatus());
    if (s->active.exchange(true)) return "busy";
    const Deadline limit = Deadline::From(deadline_.load());
    s->SetRequest(command, limit);
    return Await(s, limit);
  }
  void Stop(DWORD budget) {
    const auto s = state_.load();
    if (!s) return;
    s->Revoke();
    if (s->worker != nullptr) WaitForSingleObject(s->worker, budget);
    // Keep state_ while this Handoff lives: Begin must not replace a worker
    // still executing. At destruction the worker's independent reference wins.
  }

 public:
  Handoff() = default;
  Handoff(const Handoff&) = delete;
  Handoff& operator=(const Handoff&) = delete;
  ~Handoff() { Stop(50); }

  void SetDeadline(std::uint64_t absolute_windows_unix_ms) {
    deadline_.store(absolute_windows_unix_ms);
  }
  void Revoke() {
    const auto s = state_.load();
    if (s) s->Revoke();  // current handoff only; no worker wait
  }
  void SignalCancel() {
    transport_dead_.store(true);
    Revoke();  // permanent EOF latch; no worker wait, unhook, or focus call
  }
  std::string Begin() {
    if (transport_dead_.load()) return "cancelled";
    const auto previous = state_.load();
    if (previous && previous->worker != nullptr &&
        WaitForSingleObject(previous->worker, 0) != WAIT_OBJECT_0) return "busy";
    const Deadline limit = Deadline::From(deadline_.load());
    if (limit.Remaining() == 0) return "unavailable";
    auto s = std::shared_ptr<State>(new (std::nothrow) State);
    if (!s) return "unavailable";
    s->deadline = limit;
    s->request = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    s->completed = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (s->request == nullptr || s->completed == nullptr) return "unavailable";
    auto* retained = new (std::nothrow) std::shared_ptr<State>(s);
    if (retained == nullptr) return "unavailable";
    state_.store(s);
    // SignalCancel may race publication. Its permanent bit closes both orders.
    if (transport_dead_.load()) s->Revoke();
    s->worker = CreateThread(nullptr, 0, State::Entry, retained, 0, nullptr);
    if (s->worker == nullptr) {
      delete retained;
      s->finished.store(true);
      return "unavailable";
    }
    return Await(s, limit);
  }
  std::string Commit() { return Request(Command::Commit); }
  std::string Check() { return Request(Command::Check); }
  std::string Release() { return Request(Command::Release); }
  std::string FinishRelease() { return Request(Command::FinishRelease); }
  std::string Reason() const {
    const auto s = state_.load();
    return s ? s->reason.load() : "NO_STATE";
  }
  std::string Cancel() {
    Stop((std::min)(Deadline::From(deadline_.load()).Remaining(), DWORD{50}));
    const auto s = state_.load();
    if (!s) return "cancelled";
    return Name(s->finished.load() ? s->result.load() : s->CancelStatus());
  }

 private:
  std::atomic<std::uint64_t> deadline_{0};
  std::atomic<bool> transport_dead_{false};
  std::atomic<std::shared_ptr<State>> state_;
};

}  // namespace ab_focus
#endif  // AGENT_BROWSER_FOCUS_HANDOFF_H_
