using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// 编译：csc -nologo -optimize+ -out:occlusion-watcher.exe watcher-exe.cs
// 用法：occlusion-watcher.exe --pid <n> [--interval 500]
//       occlusion-watcher.exe --name "DeepSeek Harness" [--interval 500]
// 输出：状态变化或每 2.5 秒心跳时，向 stdout 打一行 JSON。

internal static class Watcher
{
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] private static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("shcore.dll")] private static extern int SetProcessDpiAwareness(int value);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);

    public struct POINT { public int X; public int Y; }
    public struct RECT { public int L; public int T; public int R; public int B; }

    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_LAYERED = 0x00080000;
    private const int DWMWA_CLOAKED = 14;

    private static readonly Dictionary<uint, string> NameCache = new Dictionary<uint, string>();

    private static void EnableDpiAwareness()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
        try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    /// 被 DWM 隐藏（切换虚拟桌面、UWP 挂起等）的窗口不算「盖住别人」
    private static bool IsCloaked(IntPtr h)
    {
        try
        {
            int cloaked;
            if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0) return cloaked != 0;
        }
        catch { }
        return false;
    }

    /// 点得穿 / 近乎全透明的覆盖层（NVIDIA Overlay、Nahimic、输入法候选框等）不算遮挡
    private static bool IsClickThroughOrTransparent(IntPtr h)
    {
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        if ((ex & WS_EX_TRANSPARENT) != 0) return true;
        if ((ex & WS_EX_LAYERED) != 0)
        {
            uint key; byte alpha; uint flags;
            if (GetLayeredWindowAttributes(h, out key, out alpha, out flags))
            {
                if ((flags & 0x2) != 0 && alpha < 250) return true; // LWA_ALPHA 且明显半透明
            }
        }
        return false;
    }

    private static string ProcessNameOf(uint pid)
    {
        string name;
        if (NameCache.TryGetValue(pid, out name)) return name;
        try { name = Process.GetProcessById((int)pid).ProcessName; }
        catch { name = "?"; }
        if (NameCache.Count > 400) NameCache.Clear();
        NameCache[pid] = name;
        return name;
    }

    /// 目标进程集合：给定 pid 或按进程名匹配到的所有 pid
    private static HashSet<uint> TargetPids(uint pid, string name)
    {
        var set = new HashSet<uint>();
        if (name != null)
        {
            try
            {
                foreach (var p in Process.GetProcessesByName(name)) set.Add((uint)p.Id);
            }
            catch { }
        }
        if (pid != 0) set.Add(pid);
        return set;
    }

    /// 目标集合里最大的可见顶层窗口
    private static IntPtr LargestWindow(HashSet<uint> targets)
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        EnumProc cb = delegate(IntPtr h, IntPtr l)
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!targets.Contains(pid)) return true;
            if (!IsWindowVisible(h)) return true;
            if (IsCloaked(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long a = (long)(r.R - r.L) * (long)(r.B - r.T);
            if (a > bestArea) { bestArea = a; best = h; }
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        return best;
    }

    private static uint CovererAt(int x, int y, HashSet<uint> targets, out bool ours)
    {
        POINT p;
        p.X = x;
        p.Y = y;
        IntPtr h = WindowFromPoint(p);
        ours = false;
        if (h == IntPtr.Zero)
        {
            // 采样点没落到任何窗口：没有任何东西盖住它
            ours = true;
            return 0;
        }
        IntPtr root = GetAncestor(h, 2);
        uint pid = 0;
        GetWindowThreadProcessId(root, out pid);
        if (targets.Contains(pid))
        {
            ours = true;
            return pid;
        }
        // 点得穿 / 半透明的覆盖层（NVIDIA Overlay、Nahimic、输入法候选框等）
        // 或已被 DWM 隐藏的窗口，不算「盖住」——用户其实还能看到内容。
        if (IsClickThroughOrTransparent(root) || IsCloaked(root))
        {
            ours = true;
            return pid;
        }
        return pid;
    }

    private static string Json(string state, bool focused, bool ours, uint coverPid, int hits, int total, string rect)
    {
        var sb = new StringBuilder(220);
        sb.Append("{\"state\":\"").Append(state).Append("\",\"focused\":").Append(focused ? "true" : "false");
        sb.Append(",\"hits\":").Append(hits).Append(",\"total\":").Append(total);
        sb.Append(",\"rect\":\"").Append(rect).Append("\"");
        if (coverPid != 0 && !ours)
        {
            sb.Append(",\"coverPid\":").Append(coverPid);
            sb.Append(",\"cover\":\"").Append(ProcessNameOf(coverPid).Replace("\"", "")).Append("\"");
        }
        sb.Append('}');
        return sb.ToString();
    }

    private static int Main(string[] args)
    {
        uint pid = 0;
        string name = null;
        int interval = 500;
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--pid" && i + 1 < args.Length) { uint.TryParse(args[++i], out pid); }
            else if (a == "--name" && i + 1 < args.Length) { name = args[++i]; }
            else if (a == "--interval" && i + 1 < args.Length) { int.TryParse(args[++i], out interval); }
        }
        if (pid == 0 && name == null)
        {
            Console.Error.WriteLine("usage: occlusion-watcher.exe (--pid N | --name \"App\") [--interval ms]");
            return 2;
        }
        if (interval < 100) interval = 100;

        try { EnableDpiAwareness(); } catch { }

        string last = null;
        var lastEmit = Stopwatch.StartNew();
        var outw = Console.Out;
        int ticks = 0;
        HashSet<uint> targets = null;

        while (true)
        {
            // 每 50 个 tick 重新解析一次目标进程，兼顾 DSH 重启/换 pid
            if (targets == null || targets.Count == 0 || (ticks % 50) == 0)
            {
                targets = TargetPids(pid, name);
            }
            ticks++;

            IntPtr h = LargestWindow(targets);
            string state = "nowindow";
            int hits = 0;
            int total = 0;
            string rect = "";
            uint coverPid = 0;
            bool ours = false;

            if (h == IntPtr.Zero)
            {
                state = "nowindow";
            }
            else if (IsIconic(h))
            {
                state = "minimized";
            }
            else if (!IsWindowVisible(h))
            {
                state = "hidden";
            }
            else
            {
                RECT r;
                GetWindowRect(h, out r);
                int vl = GetSystemMetrics(76), vt = GetSystemMetrics(77);
                int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
                int left = Math.Max(r.L, vl), top = Math.Max(r.T, vt);
                int right = Math.Min(r.R, vl + vw), bottom = Math.Min(r.B, vt + vh);
                int w = right - left, ht = bottom - top;
                rect = left + "," + top + "," + right + "," + bottom;

                if (w <= 8 || ht <= 8)
                {
                    state = "nowindow";
                }
                else
                {
                    bool centerOurs;
                    uint centerPid = CovererAt(left + w / 2, top + ht / 2, targets, out centerOurs);
                    if (centerOurs)
                    {
                        state = "visible";
                        hits = 1;
                        total = 1;
                        ours = true;
                    }
                    else
                    {
                        coverPid = centerPid;
                        for (int ix = 1; ix <= 4; ix++)
                        {
                            for (int iy = 1; iy <= 4; iy++)
                            {
                                int x = left + (int)(w * (ix * 0.2));
                                int y = top + (int)(ht * (iy * 0.2));
                                bool isOurs;
                                CovererAt(x, y, targets, out isOurs);
                                total++;
                                if (isOurs) hits++;
                            }
                        }
                        if (hits > 0) { state = "visible"; ours = true; }
                        else { state = "occluded"; }
                    }
                }
            }

            uint fg = 0;
            IntPtr fgh = GetForegroundWindow();
            if (fgh != IntPtr.Zero) GetWindowThreadProcessId(fgh, out fg);
            bool focused = targets.Contains(fg);

            string line = Json(state, focused, ours, coverPid, hits, total, rect);
            if (line != last || lastEmit.ElapsedMilliseconds >= 2500)
            {
                outw.WriteLine(line);
                outw.Flush();
                last = line;
                lastEmit.Restart();
            }
            Thread.Sleep(interval);
        }
    }
}
