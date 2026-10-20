/**
 * Win32 constants the window host passes to user32: window messages, system commands,
 * show states, SetWindowPos flags, system metrics, structure sizes and offsets. Values
 * follow the Windows SDK headers.
 */
export const WM_SIZE = 0x0005;
export const WM_ACTIVATE = 0x0006;
export const WA_INACTIVE = 0n;
/** Host-private message in the WM_APP range; not a Windows SDK value. */
export const WM_OBSERVE_WINDOW = 0x8003;
export const WM_CLOSE = 0x0010;
export const WM_ERASEBKGND = 0x0014;
export const WM_QUIT = 0x0012;
export const WM_GETMINMAXINFO = 0x0024;
export const WM_SIZING = 0x0214;
export const WM_WINDOWPOSCHANGING = 0x0046;
export const WM_WINDOWPOSCHANGED = 0x0047;
export const WM_MOUSEACTIVATE = 0x0021;
export const MA_NOACTIVATE = 3n;
export const WM_SYSCOMMAND = 0x0112;
export const SYSTEM_COMMAND_MASK = 0xfff0n;
export const SC_MINIMIZE = 0xf020n;
export const SC_MAXIMIZE = 0xf030n;
export const SC_RESTORE = 0xf120n;
export const WM_DISPLAYCHANGE = 0x007e;
export const SC_CLOSE = 0xf060;
export const MF_ENABLED = 0;
export const MF_GRAYED = 1;
export const MENU_ITEM_ERROR = 0xffffffff;
export const SC_SIZE = 0xf000n;
export const SC_MOVE = 0xf010n;
export const WM_ENTERSIZEMOVE = 0x0231;
export const WM_EXITSIZEMOVE = 0x0232;
export const WM_DPICHANGED = 0x02e0;

export const COLOR_WINDOW = 5;
export const CW_USEDEFAULT = -2147483648;
export const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n;
export const GWL_STYLE = -16;
export const GWL_EXSTYLE = -20;
export const GWLP_HWNDPARENT = -8;
export const GW_OWNER = 4;
export const IDI_APPLICATION = 32512n;
export const IMAGE_ICON = 1;
export const LR_LOADFROMFILE = 0x10;
export const MB_DEFBUTTON2 = 0x100;
export const MB_ICONQUESTION = 0x20;
export const MB_YESNO = 0x4;
export const MONITOR_DEFAULTTONEAREST = 2;
export const MONITOR_DEFAULTTOPRIMARY = 1;
export const PM_REMOVE = 1;
export const SM_CXSIZEFRAME = 32;
// GetSystemMetricsForDpi index of the small icon width, the taskbar overlay icon size.
export const SM_CXSMICON = 49;
export const SM_CYSIZEFRAME = 33;
export const SM_CXPADDEDBORDER = 92;
export const SM_CXMINTRACK = 34;
export const SM_CYMINTRACK = 35;
export const SM_CXMAXTRACK = 59;
export const SM_CYMAXTRACK = 60;
export const SW_HIDE = 0;
export const SW_SHOWNORMAL = 1;
export const SW_SHOWNOACTIVATE = 4;
export const SW_MINIMIZE = 6;
export const SW_RESTORE = 9;
export const SW_SHOW = 5;
export const SW_SHOWMAXIMIZED = 3;
export const SW_SHOWMINIMIZED = 2;
export const SW_SHOWMINNOACTIVE = 7;
export const SW_SHOWNA = 8;
export const SWP_FRAMECHANGED = 0x20;
export const SWP_NOMOVE = 0x2;
export const SWP_NOACTIVATE = 0x10;
export const SWP_NOSIZE = 0x1;
export const SWP_NOZORDER = 0x4;
export const WINDOWPLACEMENT_NORMAL_RECT_OFFSET = 28;
export const WINDOWPLACEMENT_FLAGS_OFFSET = 4;
export const WINDOWPLACEMENT_SHOW_CMD_OFFSET = 8;
export const WPF_RESTORETOMAXIMIZED = 0x2;
/** SetWindowDisplayAffinity values: no protection, black content in captures, omitted from captures. */
export const WDA_NONE = 0x0;
export const WDA_MONITOR = 0x1;
export const WDA_EXCLUDEFROMCAPTURE = 0x11;
/** SetLayeredWindowAttributes flag: apply the constant alpha value. */
export const LWA_ALPHA = 0x2;
export const MAX_ALPHA = 255;
export const WS_MINIMIZEBOX = 0x00020000n;
export const WS_MAXIMIZEBOX = 0x00010000n;
export const WS_THICKFRAME = 0x00040000n;
export const WS_MAXIMIZE = 0x01000000n;
export const WS_MINIMIZE = 0x20000000n;
export const IDYES = 6;
export const MINMAXINFO_SIZE = 40;
export const MONITORINFO_SIZE = 40;
export const RECT_SIZE = 16;
export const WINDOWPLACEMENT_SIZE = 44;
export const WINDOWPOS_SIZE = 40;
export const FLASHWINFO_SIZE = 32; // Win64
export const FLASHW_STOP = 0;
export const FLASHW_TRAY = 0x2;
export const FLASHW_TIMER = 0x4;
export const FLASHW_TIMERNOFG = 0xc;
