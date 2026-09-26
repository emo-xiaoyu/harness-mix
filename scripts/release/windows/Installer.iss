; Harness Mix per-user Windows installer. Payload layout is prepared by
; scripts/release/prepare-payload.cjs; defines below are injected by
; scripts/release/windows/package.cjs:
;   /DPayloadRoot=<staged payload directory>
;   /DProductVersion=<package.json version>
;   /DArch=x64|arm64
;   /DArchAllowed=x64compatible|arm64
;   /DArch64Bit=x64compatible|arm64
; Inno Setup 6.3 or newer is required (arm64 ArchitecturesAllowed support).

#define AppName "Harness Mix"
#define AppPublisher "Harness Mix"
#define AppExe "{app}\runtime\node.exe"
#ifndef PayloadRoot
#define PayloadRoot "output/installer-payload/win32-x64/payload"
#endif
#ifndef ProductVersion
#define ProductVersion "0.0.0"
#endif
#ifndef Arch
#define Arch "x64"
#endif
#ifndef ArchAllowed
#define ArchAllowed "x64compatible"
#endif
#ifndef Arch64Bit
#define Arch64Bit "x64compatible"
#endif

[Setup]
AppId={{09662B54-8C6E-4D7E-965D-80CC879A0D5C}
AppName={#AppName}
AppVersion={#ProductVersion}
AppPublisher={#AppPublisher}
AppSupportURL=https://github.com/emo-xiaoyu/harness-mix
DefaultDirName={localappdata}\Programs\{#AppName}
UsePreviousAppDir=yes
PrivilegesRequired=lowest
ArchitecturesAllowed={#ArchAllowed}
ArchitecturesInstallIn64BitMode={#Arch64Bit}
WizardStyle=modern
DisableProgramGroupPage=yes
Compression=lzma2/max
SolidCompression=yes
OutputBaseFilename=harness-mix-{#ProductVersion}-windows-{#Arch}
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\resources\harness-mix.ico
CloseApplications=no
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked

[Files]
Source: "{#PayloadRoot}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\{#AppName}"; Filename: "{#AppExe}"; Parameters: """{app}\scripts\launch-codex.cjs"""; WorkingDir: "{app}"; IconFilename: "{app}\resources\harness-mix.ico"
Name: "{userdesktop}\{#AppName}"; Filename: "{#AppExe}"; Parameters: """{app}\scripts\launch-codex.cjs"""; WorkingDir: "{app}"; IconFilename: "{app}\resources\harness-mix.ico"; Tasks: desktopicon

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
