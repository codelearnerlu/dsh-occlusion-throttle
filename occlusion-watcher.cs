using System;
using System.Runtime.InteropServices;

public class OccDpi
{
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}

public class OccWin
{
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc cb, IntPtr l);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT p);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr h, out RECT r);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr h);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr h);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr h, uint flags);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int i);

    public struct POINT { public int X; public int Y; }
    public struct RECT { public int L; public int T; public int R; public int B; }

    public static IntPtr LargestWindow(uint target)
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        EnumProc cb = delegate(IntPtr h, IntPtr l)
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid != target) return true;
            if (!IsWindowVisible(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long a = (long)(r.R - r.L) * (long)(r.B - r.T);
            if (a > bestArea) { bestArea = a; best = h; }
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        return best;
    }

    public static uint RootPid(IntPtr h)
    {
        IntPtr root = GetAncestor(h, 2); // GA_ROOT
        uint pid = 0;
        GetWindowThreadProcessId(root, out pid);
        return pid;
    }
}
