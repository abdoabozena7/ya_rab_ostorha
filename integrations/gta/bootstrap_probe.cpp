// Read-only Script Hook V bootstrap. ABI declarations follow its public SDK:
// https://www.dev-c.com/gtav/scripthookv/ (main.h, script/native functions).
// No controls, actors, camera manipulation, globals or memory patches.
#include <windows.h>
#include <cstdio>

enum eGameVersion : int { VER_UNK = -1 };
__declspec(dllimport) void scriptRegister(HMODULE, void(*)());
__declspec(dllimport) void scriptUnregister(HMODULE);
__declspec(dllimport) void scriptWait(DWORD);
__declspec(dllimport) void nativeInit(unsigned long long);
__declspec(dllimport) unsigned long long* nativeCall();
__declspec(dllimport) eGameVersion getGameVersion();

static void record(const char* stage, unsigned frame=0, unsigned gameMs=0) {
    wchar_t path[2048] = {};
    char run[128] = {};
    if (!GetEnvironmentVariableW(L"OSTORHA_BOOTSTRAP_LOG", path, 2048) ||
        !GetEnvironmentVariableA("OSTORHA_BOOTSTRAP_ID", run, 128)) return;
    HANDLE file = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return;
    char row[512];
    int size = sprintf_s(row, "{\"stage\":\"%s\",\"run_id\":\"%s\",\"pid\":%lu,"
        "\"frame\":%u,\"game_ms\":%u,\"host_tick_ms\":%llu}\n",
        stage, run, GetCurrentProcessId(), frame, gameMs, GetTickCount64());
    if (size > 0) { DWORD written; WriteFile(file, row, size, &written, nullptr); FlushFileBuffers(file); }
    CloseHandle(file);
}

static void scriptMain() {
    record("SCRIPT_ENTERED");
    // Reading these natives demonstrates the invoker on the actual game build.
    // Frame/time evidence is not sensor, physics/control or world-readiness proof.
    for (;;) {
        nativeInit(0xFC8202EFC642E6F2ULL); // GET_FRAME_COUNT
        unsigned frame = static_cast<unsigned>(*nativeCall());
        nativeInit(0x9CD27B0045628463ULL); // GET_GAME_TIMER
        unsigned gameMs = static_cast<unsigned>(*nativeCall());
        record("FRAME", frame, gameMs);
        scriptWait(250);
    }
}

BOOL APIENTRY DllMain(HMODULE self, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(self);
        record("ATTACHED");
        if (getGameVersion() != VER_UNK) scriptRegister(self, scriptMain);
    } else if (reason == DLL_PROCESS_DETACH) {
        scriptUnregister(self);
    }
    return TRUE;
}
