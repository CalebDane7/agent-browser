#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <fcntl.h>
#include <io.h>
#include <stdint.h>

#include <array>
#include <atomic>
#include <cctype>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "focus_handoff.h"

namespace {

constexpr uint32_t kFirstFrameLimit = 64U * 1024U;
constexpr uint32_t kHostToExtensionFrameLimit = 1024U * 1024U;
constexpr uint32_t kExtensionToHostFrameLimit = 64U * 1024U * 1024U;
constexpr uint32_t kConfigLimit = 16U * 1024U;
constexpr DWORD kShutdownTimeoutMs = 5000;
constexpr wchar_t kConfigFileName[] =
    L"agent-browser-native-host.config.json";
constexpr char kConfigSchema[] = "agent-browser.native-host-config.v1";
constexpr char kWireSchema[] = "agent-browser.extension-bridge.v1";

enum ExitCode : int {
  kExitOk = 0,
  kExitArguments = 2,
  kExitConfig = 3,
  kExitProtocol = 4,
  kExitLaunch = 5,
  kExitBridge = 6,
};

class UniqueHandle {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE value) : value_(value) {}
  ~UniqueHandle() { reset(); }

  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;

  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.release()) {}
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }

  HANDLE get() const { return value_; }
  explicit operator bool() const {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }
  HANDLE release() {
    HANDLE value = value_;
    value_ = nullptr;
    return value;
  }
  void reset(HANDLE value = nullptr) {
    if (*this) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = nullptr;
};

bool IsValidUtf8(std::string_view value) {
  size_t index = 0;
  while (index < value.size()) {
    const uint8_t first = static_cast<uint8_t>(value[index]);
    if (first <= 0x7f) {
      ++index;
      continue;
    }

    uint32_t codepoint = 0;
    size_t continuation_count = 0;
    uint32_t minimum = 0;
    if ((first & 0xe0U) == 0xc0U) {
      codepoint = first & 0x1fU;
      continuation_count = 1;
      minimum = 0x80;
    } else if ((first & 0xf0U) == 0xe0U) {
      codepoint = first & 0x0fU;
      continuation_count = 2;
      minimum = 0x800;
    } else if ((first & 0xf8U) == 0xf0U) {
      codepoint = first & 0x07U;
      continuation_count = 3;
      minimum = 0x10000;
    } else {
      return false;
    }

    if (index + continuation_count >= value.size()) return false;
    for (size_t offset = 1; offset <= continuation_count; ++offset) {
      const uint8_t next = static_cast<uint8_t>(value[index + offset]);
      if ((next & 0xc0U) != 0x80U) return false;
      codepoint = (codepoint << 6U) | (next & 0x3fU);
    }
    if (codepoint < minimum || codepoint > 0x10ffffU ||
        (codepoint >= 0xd800U && codepoint <= 0xdfffU)) {
      return false;
    }
    index += continuation_count + 1;
  }
  return true;
}

void AppendUtf8(uint32_t codepoint, std::string* output) {
  if (codepoint <= 0x7fU) {
    output->push_back(static_cast<char>(codepoint));
  } else if (codepoint <= 0x7ffU) {
    output->push_back(static_cast<char>(0xc0U | (codepoint >> 6U)));
    output->push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
  } else if (codepoint <= 0xffffU) {
    output->push_back(static_cast<char>(0xe0U | (codepoint >> 12U)));
    output->push_back(
        static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
    output->push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
  } else {
    output->push_back(static_cast<char>(0xf0U | (codepoint >> 18U)));
    output->push_back(
        static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3fU)));
    output->push_back(
        static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
    output->push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
  }
}

struct JsonField {
  enum class Kind { kString, kOther } kind = Kind::kOther;
  std::string string_value;
  std::string_view raw_value;
};

using JsonObject = std::map<std::string, JsonField>;

class JsonParser {
 public:
  explicit JsonParser(std::string_view input) : input_(input) {}

  bool ParseRootObject(JsonObject* output) {
    if (!IsValidUtf8(input_)) return false;
    SkipWhitespace();
    if (!ParseObject(1, output)) return false;
    SkipWhitespace();
    return position_ == input_.size();
  }

 private:
  static constexpr unsigned kMaximumDepth = 64;

  void SkipWhitespace() {
    while (position_ < input_.size()) {
      const char value = input_[position_];
      if (value != ' ' && value != '\t' && value != '\r' && value != '\n')
        break;
      ++position_;
    }
  }

  bool Consume(char expected) {
    if (position_ >= input_.size() || input_[position_] != expected)
      return false;
    ++position_;
    return true;
  }

  static int HexValue(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
  }

  bool ParseHexQuad(uint16_t* output) {
    if (position_ + 4 > input_.size()) return false;
    uint16_t value = 0;
    for (size_t count = 0; count < 4; ++count) {
      const int digit = HexValue(input_[position_++]);
      if (digit < 0) return false;
      value = static_cast<uint16_t>((value << 4U) | digit);
    }
    *output = value;
    return true;
  }

  bool ParseString(std::string* output) {
    if (!Consume('"')) return false;
    output->clear();
    while (position_ < input_.size()) {
      const uint8_t value = static_cast<uint8_t>(input_[position_++]);
      if (value == '"') return true;
      if (value < 0x20U) return false;
      if (value != '\\') {
        output->push_back(static_cast<char>(value));
        continue;
      }

      if (position_ >= input_.size()) return false;
      const char escape = input_[position_++];
      switch (escape) {
        case '"':
        case '\\':
        case '/':
          output->push_back(escape);
          break;
        case 'b':
          output->push_back('\b');
          break;
        case 'f':
          output->push_back('\f');
          break;
        case 'n':
          output->push_back('\n');
          break;
        case 'r':
          output->push_back('\r');
          break;
        case 't':
          output->push_back('\t');
          break;
        case 'u': {
          uint16_t first = 0;
          if (!ParseHexQuad(&first)) return false;
          uint32_t codepoint = first;
          if (first >= 0xd800U && first <= 0xdbffU) {
            if (position_ + 2 > input_.size() || input_[position_] != '\\' ||
                input_[position_ + 1] != 'u') {
              return false;
            }
            position_ += 2;
            uint16_t second = 0;
            if (!ParseHexQuad(&second) || second < 0xdc00U ||
                second > 0xdfffU) {
              return false;
            }
            codepoint = 0x10000U +
                        ((static_cast<uint32_t>(first) - 0xd800U) << 10U) +
                        (static_cast<uint32_t>(second) - 0xdc00U);
          } else if (first >= 0xdc00U && first <= 0xdfffU) {
            return false;
          }
          AppendUtf8(codepoint, output);
          break;
        }
        default:
          return false;
      }
    }
    return false;
  }

  bool ParseNumber() {
    if (position_ < input_.size() && input_[position_] == '-') ++position_;
    if (position_ >= input_.size()) return false;

    if (input_[position_] == '0') {
      ++position_;
      if (position_ < input_.size() &&
          std::isdigit(static_cast<unsigned char>(input_[position_]))) {
        return false;
      }
    } else {
      if (input_[position_] < '1' || input_[position_] > '9') return false;
      do {
        ++position_;
      } while (position_ < input_.size() &&
               std::isdigit(static_cast<unsigned char>(input_[position_])));
    }

    if (position_ < input_.size() && input_[position_] == '.') {
      ++position_;
      const size_t start = position_;
      while (position_ < input_.size() &&
             std::isdigit(static_cast<unsigned char>(input_[position_]))) {
        ++position_;
      }
      if (position_ == start) return false;
    }

    if (position_ < input_.size() &&
        (input_[position_] == 'e' || input_[position_] == 'E')) {
      ++position_;
      if (position_ < input_.size() &&
          (input_[position_] == '+' || input_[position_] == '-')) {
        ++position_;
      }
      const size_t start = position_;
      while (position_ < input_.size() &&
             std::isdigit(static_cast<unsigned char>(input_[position_]))) {
        ++position_;
      }
      if (position_ == start) return false;
    }
    return true;
  }

  bool ParseLiteral(std::string_view literal) {
    if (input_.substr(position_, literal.size()) != literal) return false;
    position_ += literal.size();
    return true;
  }

  bool ParseArray(unsigned depth) {
    if (depth > kMaximumDepth || !Consume('[')) return false;
    SkipWhitespace();
    if (Consume(']')) return true;
    for (;;) {
      JsonField ignored;
      if (!ParseValue(depth + 1, &ignored)) return false;
      SkipWhitespace();
      if (Consume(']')) return true;
      if (!Consume(',')) return false;
      SkipWhitespace();
    }
  }

  bool ParseObject(unsigned depth, JsonObject* captured) {
    if (depth > kMaximumDepth || !Consume('{')) return false;
    std::set<std::string> keys;
    SkipWhitespace();
    if (Consume('}')) return true;
    for (;;) {
      std::string key;
      if (!ParseString(&key) || !keys.insert(key).second) return false;
      SkipWhitespace();
      if (!Consume(':')) return false;
      SkipWhitespace();

      JsonField field;
      const size_t value_start = position_;
      if (!ParseValue(depth + 1, &field)) return false;
      field.raw_value = input_.substr(value_start, position_ - value_start);
      if (captured != nullptr) captured->emplace(std::move(key), std::move(field));

      SkipWhitespace();
      if (Consume('}')) return true;
      if (!Consume(',')) return false;
      SkipWhitespace();
    }
  }

  bool ParseValue(unsigned depth, JsonField* output) {
    if (depth > kMaximumDepth || position_ >= input_.size()) return false;
    output->kind = JsonField::Kind::kOther;
    output->string_value.clear();
    switch (input_[position_]) {
      case '"':
        output->kind = JsonField::Kind::kString;
        return ParseString(&output->string_value);
      case '{':
        return ParseObject(depth, nullptr);
      case '[':
        return ParseArray(depth);
      case 't':
        return ParseLiteral("true");
      case 'f':
        return ParseLiteral("false");
      case 'n':
        return ParseLiteral("null");
      default:
        return ParseNumber();
    }
  }

  std::string_view input_;
  size_t position_ = 0;
};

const std::string* RequiredString(const JsonObject& object,
                                  const char* name) {
  const auto found = object.find(name);
  if (found == object.end() ||
      found->second.kind != JsonField::Kind::kString) {
    return nullptr;
  }
  return &found->second.string_value;
}

bool IsLowerHex64(std::string_view value) {
  if (value.size() != 64) return false;
  for (const char character : value) {
    if (!((character >= '0' && character <= '9') ||
          (character >= 'a' && character <= 'f'))) {
      return false;
    }
  }
  return true;
}

bool IsCanonicalVersion(std::string_view value) {
  if (value.empty()) return false;
  size_t position = 0;
  unsigned components = 0;
  while (position < value.size()) {
    if (++components > 4) return false;
    const size_t start = position;
    uint32_t component = 0;
    while (position < value.size() && value[position] >= '0' &&
           value[position] <= '9') {
      component = component * 10U + static_cast<uint32_t>(value[position] - '0');
      if (component > 65535U) return false;
      ++position;
    }
    if (position == start) return false;
    if (position - start > 1 && value[start] == '0') return false;
    if (position == value.size()) break;
    if (value[position++] != '.' || position == value.size()) return false;
  }
  return components >= 1 && components <= 4;
}

bool IsCanonicalOrigin(std::string_view value) {
  constexpr std::string_view prefix = "chrome-extension://";
  constexpr size_t id_length = 32;
  if (value.size() != prefix.size() + id_length + 1 ||
      value.substr(0, prefix.size()) != prefix || value.back() != '/') {
    return false;
  }
  for (size_t index = prefix.size(); index < prefix.size() + id_length;
       ++index) {
    if (value[index] < 'a' || value[index] > 'p') return false;
  }
  return true;
}

bool IsCanonicalDistro(std::string_view value) {
  if (value.empty() || value.size() > 128 || value.front() == ' ' ||
      value.back() == ' ') {
    return false;
  }
  bool previous_space = false;
  for (const unsigned char character : value) {
    const bool accepted = std::isalnum(character) || character == '.' ||
                          character == '_' || character == '-' ||
                          character == ' ';
    if (!accepted || (character == ' ' && previous_space)) return false;
    previous_space = character == ' ';
  }
  return true;
}

bool IsCanonicalWslPath(std::string_view value) {
  if (value.size() < 2 || value.size() > 1024 || value.front() != '/' ||
      value.back() == '/') {
    return false;
  }
  size_t segment_start = 1;
  for (size_t index = 1; index <= value.size(); ++index) {
    if (index < value.size()) {
      const unsigned char character = value[index];
      if (character < 0x20U || character == 0x7fU || character == '\\')
        return false;
      if (character != '/') continue;
    }
    if (index == segment_start) return false;
    const std::string_view segment =
        value.substr(segment_start, index - segment_start);
    if (segment == "." || segment == "..") return false;
    segment_start = index + 1;
  }
  return IsValidUtf8(value);
}

bool ValidateWireFrame(const std::vector<uint8_t>& payload, bool first) {
  if (first && payload.size() > kFirstFrameLimit) return false;
  const std::string_view json(reinterpret_cast<const char*>(payload.data()),
                              payload.size());
  JsonObject object;
  JsonParser parser(json);
  if (!parser.ParseRootObject(&object)) return false;

  const std::string* schema = RequiredString(object, "schema");
  if (schema == nullptr || *schema != kWireSchema) return false;
  if (!first) return true;

  static const std::set<std::string> expected_fields = {
      "connectionEpoch", "extensionVersion", "profileKey", "schema", "type"};
  if (object.size() != expected_fields.size()) return false;
  for (const auto& entry : object) {
    if (expected_fields.find(entry.first) == expected_fields.end()) return false;
  }

  const std::string* type = RequiredString(object, "type");
  const std::string* profile = RequiredString(object, "profileKey");
  const std::string* epoch = RequiredString(object, "connectionEpoch");
  const std::string* version = RequiredString(object, "extensionVersion");
  return type != nullptr && *type == "hello" && profile != nullptr &&
         IsLowerHex64(*profile) && epoch != nullptr && IsLowerHex64(*epoch) &&
         version != nullptr && IsCanonicalVersion(*version);
}

enum class IoResult { kOk, kEof, kError };

IoResult ReadExact(HANDLE handle, uint8_t* buffer, size_t size,
                   bool clean_eof_allowed) {
  size_t offset = 0;
  while (offset < size) {
    DWORD received = 0;
    const DWORD chunk = static_cast<DWORD>(
        (size - offset) > 0xffffffffULL ? 0xffffffffULL : size - offset);
    if (!ReadFile(handle, buffer + offset, chunk, &received, nullptr)) {
      const DWORD error = GetLastError();
      if (offset == 0 && clean_eof_allowed &&
          (error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF ||
           error == ERROR_OPERATION_ABORTED)) {
        return IoResult::kEof;
      }
      return IoResult::kError;
    }
    if (received == 0) {
      return offset == 0 && clean_eof_allowed ? IoResult::kEof
                                               : IoResult::kError;
    }
    offset += received;
  }
  return IoResult::kOk;
}

bool WriteExact(HANDLE handle, const uint8_t* buffer, size_t size) {
  size_t offset = 0;
  while (offset < size) {
    DWORD written = 0;
    const DWORD chunk = static_cast<DWORD>(
        (size - offset) > 0xffffffffULL ? 0xffffffffULL : size - offset);
    if (!WriteFile(handle, buffer + offset, chunk, &written, nullptr) ||
        written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

struct Frame {
  std::array<uint8_t, 4> header{};
  std::vector<uint8_t> payload;
};

enum class FrameResult { kFrame, kEof, kIoError, kProtocolError };

FrameResult ReadFrame(HANDLE handle, uint32_t limit, Frame* frame) {
  const IoResult header_result =
      ReadExact(handle, frame->header.data(), frame->header.size(), true);
  if (header_result == IoResult::kEof) return FrameResult::kEof;
  if (header_result != IoResult::kOk) return FrameResult::kIoError;

  const uint32_t length = static_cast<uint32_t>(frame->header[0]) |
                          (static_cast<uint32_t>(frame->header[1]) << 8U) |
                          (static_cast<uint32_t>(frame->header[2]) << 16U) |
                          (static_cast<uint32_t>(frame->header[3]) << 24U);
  if (length == 0 || length > limit) return FrameResult::kProtocolError;
  frame->payload.resize(length);
  return ReadExact(handle, frame->payload.data(), frame->payload.size(), false) ==
                 IoResult::kOk
             ? FrameResult::kFrame
             : FrameResult::kIoError;
}

bool WriteFrame(HANDLE handle, const Frame& frame) {
  return WriteExact(handle, frame.header.data(), frame.header.size()) &&
         WriteExact(handle, frame.payload.data(), frame.payload.size());
}

bool ReadSmallFile(const std::wstring& path, uint32_t limit,
                   std::vector<uint8_t>* output) {
  UniqueHandle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ,
                                nullptr, OPEN_EXISTING,
                                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN,
                                nullptr));
  if (!file) return false;
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file.get(), &size) || size.QuadPart <= 0 ||
      size.QuadPart > limit) {
    return false;
  }
  output->resize(static_cast<size_t>(size.QuadPart));
  return ReadExact(file.get(), output->data(), output->size(), false) ==
         IoResult::kOk;
}

bool ExecutableDirectory(std::wstring* output) {
  std::vector<wchar_t> buffer(32768);
  const DWORD length =
      GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (length == 0 || length >= buffer.size()) return false;
  std::wstring path(buffer.data(), length);
  const size_t separator = path.find_last_of(L"\\/");
  if (separator == std::wstring::npos) return false;
  *output = path.substr(0, separator);
  return true;
}

bool Utf8ToWide(std::string_view input, std::wstring* output) {
  if (input.empty() || input.size() > static_cast<size_t>(INT_MAX) ||
      input.find('\0') != std::string_view::npos) {
    return false;
  }
  const int required = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, input.data(), static_cast<int>(input.size()),
      nullptr, 0);
  if (required <= 0) return false;
  output->resize(static_cast<size_t>(required));
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                             static_cast<int>(input.size()), output->data(),
                             required) == required;
}

struct Config {
  std::string allowed_origin_utf8;
  std::wstring allowed_origin;
  std::wstring wsl_distro;
  std::wstring wsl_bridge_path;
};

bool LoadConfig(const std::wstring& directory, Config* config) {
  std::vector<uint8_t> bytes;
  if (!ReadSmallFile(directory + L"\\" + kConfigFileName, kConfigLimit,
                     &bytes)) {
    return false;
  }
  const std::string_view json(reinterpret_cast<const char*>(bytes.data()),
                              bytes.size());
  JsonObject object;
  JsonParser parser(json);
  if (!parser.ParseRootObject(&object) || object.size() != 4) return false;
  const std::string* schema = RequiredString(object, "schema");
  const std::string* origin = RequiredString(object, "allowed_origin");
  const std::string* distro = RequiredString(object, "wsl_distro");
  const std::string* bridge = RequiredString(object, "wsl_bridge_path");
  if (schema == nullptr || *schema != kConfigSchema || origin == nullptr ||
      !IsCanonicalOrigin(*origin) || distro == nullptr ||
      !IsCanonicalDistro(*distro) || bridge == nullptr ||
      !IsCanonicalWslPath(*bridge)) {
    return false;
  }
  if (object.find("schema") == object.end() ||
      object.find("allowed_origin") == object.end() ||
      object.find("wsl_distro") == object.end() ||
      object.find("wsl_bridge_path") == object.end()) {
    return false;
  }

  config->allowed_origin_utf8 = *origin;
  return Utf8ToWide(*origin, &config->allowed_origin) &&
         Utf8ToWide(*distro, &config->wsl_distro) &&
         Utf8ToWide(*bridge, &config->wsl_bridge_path);
}

bool IsCanonicalParentWindow(std::wstring_view argument) {
  constexpr std::wstring_view prefix = L"--parent-window=";
  if (argument.size() <= prefix.size() || argument.substr(0, prefix.size()) != prefix)
    return false;
  const std::wstring_view value = argument.substr(prefix.size());
  if (value.size() > 20 || (value.size() > 1 && value.front() == L'0'))
    return false;
  uint64_t parsed = 0;
  for (const wchar_t character : value) {
    if (character < L'0' || character > L'9') return false;
    const uint64_t digit = static_cast<uint64_t>(character - L'0');
    if (parsed > (UINT64_MAX - digit) / 10U) return false;
    parsed = parsed * 10U + digit;
  }
  return true;
}

std::wstring QuoteWindowsArgument(std::wstring_view argument) {
  if (!argument.empty() &&
      argument.find_first_of(L" \t\n\v\"") == std::wstring_view::npos) {
    return std::wstring(argument);
  }
  std::wstring quoted(1, L'"');
  size_t backslashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'"');
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(character);
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

std::wstring BuildCommandLine(const std::vector<std::wstring>& arguments) {
  std::wstring command_line;
  for (size_t index = 0; index < arguments.size(); ++index) {
    if (index != 0) command_line.push_back(L' ');
    command_line += QuoteWindowsArgument(arguments[index]);
  }
  return command_line;
}

struct ChildProcess {
  UniqueHandle job;
  UniqueHandle process;
  UniqueHandle stdin_write;
  UniqueHandle stdout_read;
};

bool LaunchBridge(const Config& config, const std::wstring& origin,
                  ChildProcess* child) {
  wchar_t system_directory[MAX_PATH + 1]{};
  const UINT system_length =
      GetSystemDirectoryW(system_directory, MAX_PATH + 1);
  if (system_length == 0 || system_length > MAX_PATH) return false;
  const std::wstring wsl_path =
      std::wstring(system_directory, system_length) + L"\\wsl.exe";

  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;

  UniqueHandle child_stdin_read;
  UniqueHandle child_stdout_write;
  HANDLE read_handle = nullptr;
  HANDLE write_handle = nullptr;
  if (!CreatePipe(&read_handle, &write_handle, &security, 0)) return false;
  child_stdin_read.reset(read_handle);
  child->stdin_write.reset(write_handle);
  if (!SetHandleInformation(child->stdin_write.get(), HANDLE_FLAG_INHERIT, 0))
    return false;

  read_handle = nullptr;
  write_handle = nullptr;
  if (!CreatePipe(&read_handle, &write_handle, &security, 0)) return false;
  child->stdout_read.reset(read_handle);
  child_stdout_write.reset(write_handle);
  if (!SetHandleInformation(child->stdout_read.get(), HANDLE_FLAG_INHERIT, 0))
    return false;

  UniqueHandle null_error(CreateFileW(
      L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!null_error) return false;

  child->job.reset(CreateJobObjectW(nullptr, nullptr));
  if (!child->job) return false;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION job_limits{};
  job_limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(child->job.get(), JobObjectExtendedLimitInformation,
                               &job_limits, sizeof(job_limits))) {
    return false;
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = child_stdin_read.get();
  startup.StartupInfo.hStdOutput = child_stdout_write.get();
  startup.StartupInfo.hStdError = null_error.get();

  SIZE_T attribute_size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_size);
  if (attribute_size == 0) return false;
  std::vector<uint8_t> attributes(attribute_size);
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
      attributes.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0,
                                         &attribute_size)) {
    return false;
  }

  const std::array<HANDLE, 3> inherited = {
      child_stdin_read.get(), child_stdout_write.get(), null_error.get()};
  const bool attribute_ok = UpdateProcThreadAttribute(
      startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      const_cast<HANDLE*>(inherited.data()), sizeof(inherited), nullptr, nullptr);
  if (!attribute_ok) {
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    return false;
  }

  const std::vector<std::wstring> arguments = {
      wsl_path, L"--distribution", config.wsl_distro, L"--exec",
      config.wsl_bridge_path, L"--origin", origin};
  std::wstring command_line = BuildCommandLine(arguments);
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');

  PROCESS_INFORMATION process_info{};
  const BOOL created = CreateProcessW(
      wsl_path.c_str(), mutable_command.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr,
      nullptr, &startup.StartupInfo, &process_info);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (!created) return false;

  UniqueHandle process(process_info.hProcess);
  UniqueHandle thread(process_info.hThread);
  if (!AssignProcessToJobObject(child->job.get(), process.get()) ||
      ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
    TerminateProcess(process.get(), 1);
    WaitForSingleObject(process.get(), kShutdownTimeoutMs);
    return false;
  }

  child->process = std::move(process);
  return true;
}

enum class PumpStatus : int {
  kRunning = 0,
  kCleanEof = 1,
  kProtocolError = 2,
  kIoError = 3,
};

// WHY: Native focus replies and Chrome replies share one framed input stream.
// Lock the entire length+payload write (and close), not individual WriteFile
// calls; interleaved frames otherwise break unrelated browser commands.
struct SharedPipeWriter {
  SRWLOCK lock = SRWLOCK_INIT;
  HANDLE handle = nullptr;
  bool Write(const Frame& frame) {
    AcquireSRWLockExclusive(&lock);
    const bool ok = handle != nullptr && WriteFrame(handle, frame);
    ReleaseSRWLockExclusive(&lock);
    return ok;
  }
  void Close() {
    AcquireSRWLockExclusive(&lock);
    if (handle != nullptr) CloseHandle(handle);
    handle = nullptr;
    ReleaseSRWLockExclusive(&lock);
  }
  ~SharedPipeWriter() { Close(); }
};

struct FocusBinding {
  SRWLOCK lock = SRWLOCK_INIT;
  std::string token;
  std::string session;
  std::string tab;
  bool Matches(const std::string& wanted_token, const std::string& wanted_session,
               const std::string& wanted_tab) const {
    return !token.empty() && token == wanted_token &&
           session == wanted_session && tab == wanted_tab;
  }
};

struct PumpContext {
  HANDLE source = nullptr;
  HANDLE destination = nullptr;
  uint32_t frame_limit = 0;
  bool validate_first = false;
  SharedPipeWriter* shared_destination = nullptr;
  SharedPipeWriter* native_reply = nullptr;
  std::string profile_key;
  std::string connection_epoch;
  std::shared_ptr<ab_focus::Handoff> focus;
  FocusBinding* focus_binding = nullptr;
  std::atomic<bool> cancel_requested{false};
  std::atomic<int> status{static_cast<int>(PumpStatus::kRunning)};
};

bool FocusIdentity(const JsonObject& args, const std::string** token,
                    const std::string** session, const std::string** tab) {
  *token = RequiredString(args, "handoffToken");
  *session = RequiredString(args, "session");
  *tab = RequiredString(args, "tabId");
  if (*token == nullptr || !IsLowerHex64(**token) || *session == nullptr ||
      (*session)->empty() || (*session)->size() > 128 || *tab == nullptr ||
      (*tab)->size() != 68 || (*tab)->substr(0, 4) != "tab_" ||
      !IsLowerHex64(std::string_view(**tab).substr(4))) return false;
  for (const unsigned char ch : **session)
    if (!std::isalnum(ch) && ch != '_' && ch != '-' && ch != '.') return false;
  return true;
}

// Chrome tab changes do not necessarily change the native HWND. Consume the
// exact lease's cancellation before it waits behind an output-side release,
// while preserving the original event for the broker's ownership bookkeeping.
void ObserveFocusCancellation(const Frame& frame, PumpContext* context) {
  if (context->native_reply != nullptr || frame.payload.size() > 2048) return;
  const std::string_view json(reinterpret_cast<const char*>(frame.payload.data()),
                              frame.payload.size());
  if (json.find("focus.cancelled") == std::string_view::npos) return;
  JsonObject object, params;
  if (!JsonParser(json).ParseRootObject(&object)) return;
  const auto raw = object.find("params");
  const std::string* type = RequiredString(object, "type");
  const std::string* method = RequiredString(object, "method");
  const std::string* profile = RequiredString(object, "profileKey");
  const std::string* epoch = RequiredString(object, "connectionEpoch");
  const std::string* tab = RequiredString(object, "tabId");
  if (object.size() != 7 || type == nullptr || *type != "event" ||
      method == nullptr || *method != "focus.cancelled" ||
      profile == nullptr || *profile != context->profile_key || epoch == nullptr ||
      *epoch != context->connection_epoch || tab == nullptr || raw == object.end() ||
      !JsonParser(raw->second.raw_value).ParseRootObject(&params) || params.size() != 2)
    return;
  const std::string* token = RequiredString(params, "handoffToken");
  const std::string* session = RequiredString(params, "session");
  if (token == nullptr || session == nullptr) return;
  FocusBinding& binding = *context->focus_binding;
  AcquireSRWLockExclusive(&binding.lock);
  if (binding.Matches(*token, *session, *tab)) context->focus->Revoke();
  ReleaseSRWLockExclusive(&binding.lock);
}

uint64_t FocusDeadline(const JsonObject& object) {
  const auto found = object.find("deadlineAt");
  if (found == object.end()) return 0;
  const std::string_view text = found->second.raw_value;
  if (text.empty() || text.size() > 15) return 0;
  uint64_t deadline = 0;
  for (const char digit : text) {
    if (digit < '0' || digit > '9') return 0;
    deadline = deadline * 10U + static_cast<uint64_t>(digit - '0');
  }
  FILETIME now;
  GetSystemTimeAsFileTime(&now);
  const uint64_t ticks = (static_cast<uint64_t>(now.dwHighDateTime) << 32U) |
                        now.dwLowDateTime;
  const uint64_t millis = (ticks - 116444736000000000ULL) / 10000ULL;
  return deadline > millis && deadline - millis <= 30000ULL ? deadline : 0;
}

// Only the already-authenticated broker -> native direction can invoke these
// commands. HWNDs and process IDs never cross the browser/page protocol. The
// broker owns session authorization; this host additionally pins the live
// extension generation and observes the Windows interval until release/EOF.
enum class FocusFrame { kPass, kHandled, kFailed };
FocusFrame HandleFocusFrame(const Frame& frame, PumpContext* context,
                            ab_focus::Handoff* focus) {
  if (context->native_reply == nullptr || frame.payload.size() > 2048)
    return FocusFrame::kPass;
  const std::string_view json(reinterpret_cast<const char*>(frame.payload.data()),
                              frame.payload.size());
  if (json.find("native.focus.") == std::string_view::npos)
    return FocusFrame::kPass;
  JsonObject object;
  if (!JsonParser(json).ParseRootObject(&object)) return FocusFrame::kFailed;
  const std::string* op = RequiredString(object, "op");
  if (op == nullptr || op->rfind("native.focus.", 0) != 0)
    return FocusFrame::kPass;
  if (*op != "native.focus.begin" && *op != "native.focus.commit" &&
      *op != "native.focus.check" && *op != "native.focus.release" &&
      *op != "native.focus.finish-release" &&
      *op != "native.focus.cancel") return FocusFrame::kFailed;
  const std::string* id = RequiredString(object, "id");
  const std::string* type = RequiredString(object, "type");
  const std::string* profile = RequiredString(object, "profileKey");
  const std::string* epoch = RequiredString(object, "connectionEpoch");
  const auto args = object.find("args");
  JsonObject focus_args;
  if (id == nullptr || !IsLowerHex64(*id) || type == nullptr ||
      *type != "request" || profile == nullptr || epoch == nullptr ||
      *profile != context->profile_key || *epoch != context->connection_epoch ||
      object.size() != 8 || args == object.end() ||
      !JsonParser(args->second.raw_value).ParseRootObject(&focus_args) ||
      focus_args.size() != 3) return FocusFrame::kFailed;
  const std::string *token, *session, *tab;
  if (!FocusIdentity(focus_args, &token, &session, &tab)) return FocusFrame::kFailed;
  FocusBinding& binding = *context->focus_binding;
  AcquireSRWLockExclusive(&binding.lock);
  const bool matches = binding.Matches(*token, *session, *tab);
  const bool begin = *op == "native.focus.begin" && binding.token.empty();
  if (begin) {
    binding.token = *token;
    binding.session = *session;
    binding.tab = *tab;
  }
  ReleaseSRWLockExclusive(&binding.lock);
  std::string status = "unavailable";
  const uint64_t deadline = FocusDeadline(object);
  if ((matches || begin) && deadline != 0) {
    focus->SetDeadline(deadline);
    if (*op == "native.focus.begin") status = focus->Begin();
    else if (*op == "native.focus.commit") status = focus->Commit();
    else if (*op == "native.focus.check") status = focus->Check();
    else if (*op == "native.focus.release") status = focus->Release();
    else if (*op == "native.focus.finish-release") status = focus->FinishRelease();
    else if (*op == "native.focus.cancel") status = focus->Cancel();
  } else if (matches || begin) {
    // Expired work may revoke a lease, never perform a delayed focus return.
    focus->Cancel();
  }
  if ((matches || begin) && status != "captured" && status != "armed" &&
      status != "unchanged" && status != "prepared" && status != "busy") {
    AcquireSRWLockExclusive(&binding.lock);
    binding.token.clear(); binding.session.clear(); binding.tab.clear();
    ReleaseSRWLockExclusive(&binding.lock);
  }
  const std::string response = "{\"id\":\"" + *id +
      "\",\"ok\":true,\"result\":{\"status\":\"" + status +
      "\",\"nativeReason\":\"" + focus->Reason() +
      "\"},\"schema\":\"" + kWireSchema + "\",\"type\":\"response\"}";
  Frame reply;
  reply.payload.assign(response.begin(), response.end());
  // WHY: Forwarded frames already carry their length; this locally generated
  // reply does not. The Windows wire replay rejected a zero-length header
  // before any focus action. Encode UTF-8 byte count, not a string character
  // count, preserving the native-messaging length+payload contract.
  const uint32_t length = static_cast<uint32_t>(reply.payload.size());
  for (size_t index = 0; index < reply.header.size(); ++index)
    reply.header[index] = static_cast<uint8_t>(length >> (index * 8U));
  return context->native_reply->Write(reply) ? FocusFrame::kHandled
                                            : FocusFrame::kFailed;
}

DWORD WINAPI PumpFrames(void* opaque) {
  PumpContext* context = static_cast<PumpContext*>(opaque);
  UniqueHandle destination(context->shared_destination == nullptr
                               ? context->destination : nullptr);
  struct CloseSharedOnExit {
    SharedPipeWriter* writer;
    std::shared_ptr<ab_focus::Handoff> focus;
    ~CloseSharedOnExit() {
      // Chrome EOF revokes a queued return even if the output worker is still
      // waiting on it. Revocation does not focus, block, or free callback state.
      focus->SignalCancel();
      if (writer != nullptr) writer->Close();
    }
  } close_shared{context->shared_destination, context->focus};
  UniqueHandle source_to_close;
  if (context->source != GetStdHandle(STD_INPUT_HANDLE) &&
      context->source != GetStdHandle(STD_OUTPUT_HANDLE)) {
    source_to_close.reset(context->source);
  }

  bool first = context->validate_first;
  for (;;) {
    Frame frame;
    const FrameResult result =
        ReadFrame(context->source, context->frame_limit, &frame);
    if (result == FrameResult::kEof) {
      context->status.store(static_cast<int>(
          context->cancel_requested.load() ? PumpStatus::kIoError
                                           : PumpStatus::kCleanEof));
      return 0;
    }
    if (result != FrameResult::kFrame) {
      context->status.store(static_cast<int>(
          result == FrameResult::kProtocolError ? PumpStatus::kProtocolError
                                                : PumpStatus::kIoError));
      return 1;
    }
    if (!ValidateWireFrame(frame.payload, first)) {
      context->status.store(static_cast<int>(PumpStatus::kProtocolError));
      return 1;
    }
    first = false;
    ObserveFocusCancellation(frame, context);
    const FocusFrame focus_result = HandleFocusFrame(frame, context, context->focus.get());
    if (focus_result == FocusFrame::kHandled) continue;
    if (focus_result == FocusFrame::kFailed ||
        !(context->shared_destination != nullptr
              ? context->shared_destination->Write(frame)
              : WriteFrame(context->destination, frame))) {
      context->status.store(static_cast<int>(PumpStatus::kIoError));
      return 1;
    }
  }
}

bool ThreadFinished(HANDLE thread) {
  return WaitForSingleObject(thread, 0) == WAIT_OBJECT_0;
}

PumpStatus PumpState(const PumpContext& context) {
  return static_cast<PumpStatus>(context.status.load());
}

int Relay(HANDLE chrome_input, HANDLE chrome_output, ChildProcess* child,
          const JsonObject& hello) {
  SharedPipeWriter child_input;
  child_input.handle = child->stdin_write.release();
  const auto focus = std::make_shared<ab_focus::Handoff>();
  FocusBinding binding;
  PumpContext input_context;
  input_context.source = chrome_input;
  // WHY: Chrome sends extension messages on native-host stdin and documents a
  // 64 MiB ceiling in this direction. Keeping the host-output 1 MiB limit here
  // rejected valid large CDP replies before the broker could consume them.
  input_context.frame_limit = kExtensionToHostFrameLimit;
  input_context.shared_destination = &child_input;
  input_context.focus = focus;
  input_context.focus_binding = &binding;
  input_context.profile_key = *RequiredString(hello, "profileKey");
  input_context.connection_epoch = *RequiredString(hello, "connectionEpoch");

  PumpContext output_context;
  output_context.source = child->stdout_read.release();
  output_context.destination = chrome_output;
  output_context.frame_limit = kHostToExtensionFrameLimit;
  output_context.native_reply = &child_input;
  output_context.focus = focus;
  output_context.focus_binding = &binding;
  output_context.profile_key = *RequiredString(hello, "profileKey");
  output_context.connection_epoch = *RequiredString(hello, "connectionEpoch");

  UniqueHandle input_thread(CreateThread(nullptr, 0, PumpFrames, &input_context,
                                         0, nullptr));
  if (!input_thread) return kExitBridge;
  UniqueHandle output_thread(CreateThread(nullptr, 0, PumpFrames, &output_context,
                                          0, nullptr));
  if (!output_thread) {
    CancelSynchronousIo(input_thread.get());
    TerminateJobObject(child->job.get(), 1);
    WaitForSingleObject(input_thread.get(), kShutdownTimeoutMs);
    return kExitBridge;
  }

  const std::array<HANDLE, 3> waits = {
      child->process.get(), input_thread.get(), output_thread.get()};
  const DWORD signaled = WaitForMultipleObjects(
      static_cast<DWORD>(waits.size()), waits.data(), FALSE, INFINITE);
  bool forced = false;

  if (signaled == WAIT_OBJECT_0 + 1) {
    const PumpStatus state = PumpState(input_context);
    const DWORD timeout = state == PumpStatus::kCleanEof ? kShutdownTimeoutMs : 0;
    if (WaitForSingleObject(child->process.get(), timeout) != WAIT_OBJECT_0) {
      TerminateJobObject(child->job.get(), 1);
      forced = true;
    }
  } else if (signaled == WAIT_OBJECT_0 + 2) {
    if (WaitForSingleObject(child->process.get(), 1000) != WAIT_OBJECT_0) {
      TerminateJobObject(child->job.get(), 1);
      forced = true;
    }
  } else if (signaled < WAIT_OBJECT_0 || signaled > WAIT_OBJECT_0 + 2) {
    TerminateJobObject(child->job.get(), 1);
    forced = true;
  }

  WaitForSingleObject(child->process.get(), kShutdownTimeoutMs);
  if (!ThreadFinished(input_thread.get())) {
    WaitForSingleObject(input_thread.get(), 100);
  }
  if (!ThreadFinished(input_thread.get())) {
    input_context.cancel_requested.store(true);
    CancelSynchronousIo(input_thread.get());
  }
  if (!ThreadFinished(output_thread.get())) {
    output_context.cancel_requested.store(true);
    CancelSynchronousIo(output_thread.get());
  }
  WaitForSingleObject(input_thread.get(), 1000);
  // Focus requests use a bounded <=2500ms owner wait. Let that owner revoke
  // and unwind after pipe EOF before destroying its relay context.
  WaitForSingleObject(output_thread.get(), 3500);

  DWORD child_exit = 1;
  GetExitCodeProcess(child->process.get(), &child_exit);
  const PumpStatus input_state = PumpState(input_context);
  const PumpStatus output_state = PumpState(output_context);
  const bool clean = !forced && child_exit == 0 &&
                     input_state == PumpStatus::kCleanEof &&
                     output_state == PumpStatus::kCleanEof;
  if (clean) return kExitOk;
  if (input_state == PumpStatus::kProtocolError ||
      output_state == PumpStatus::kProtocolError) {
    return kExitProtocol;
  }
  return kExitBridge;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX |
               SEM_NOOPENFILEERRORBOX);
  SetDllDirectoryW(L"");
  if (_setmode(_fileno(stdin), _O_BINARY) == -1 ||
      _setmode(_fileno(stdout), _O_BINARY) == -1) {
    return kExitProtocol;
  }

  std::wstring executable_directory;
  Config config;
  if (!ExecutableDirectory(&executable_directory) ||
      !LoadConfig(executable_directory, &config)) {
    return kExitConfig;
  }
  if ((argc != 2 && argc != 3) || argv[1] != config.allowed_origin ||
      (argc == 3 && !IsCanonicalParentWindow(argv[2]))) {
    return kExitArguments;
  }

  HANDLE chrome_input = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE chrome_output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (chrome_input == nullptr || chrome_input == INVALID_HANDLE_VALUE ||
      chrome_output == nullptr || chrome_output == INVALID_HANDLE_VALUE) {
    return kExitProtocol;
  }

  Frame first_frame;
  if (ReadFrame(chrome_input, kFirstFrameLimit, &first_frame) !=
          FrameResult::kFrame ||
      !ValidateWireFrame(first_frame.payload, true)) {
    return kExitProtocol;
  }

  ChildProcess child;
  if (!LaunchBridge(config, argv[1], &child)) return kExitLaunch;
  if (!WriteFrame(child.stdin_write.get(), first_frame)) {
    TerminateJobObject(child.job.get(), 1);
    WaitForSingleObject(child.process.get(), kShutdownTimeoutMs);
    return kExitBridge;
  }

  JsonObject hello;
  const std::string_view hello_json(
      reinterpret_cast<const char*>(first_frame.payload.data()),
      first_frame.payload.size());
  if (!JsonParser(hello_json).ParseRootObject(&hello)) return kExitProtocol;
  return Relay(chrome_input, chrome_output, &child, hello);
}
