using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AgentWatch.Overlay;

/// <summary>
/// An always-on-top window with no title bar that shows http://localhost:4777/?overlay=1.
/// The page's status bar is a drag region (CSS app-region: drag, handled by WebView2), and its buttons
/// post "open" and "close" messages here. Like MRAkdown, the window keeps its normal frame so it can
/// be resized from the sides and bottom and keeps its shadow and rounded corners; only the caption is
/// given to the page. If nothing answers on the port, the window starts server.js itself and stops it
/// again when it closes.
/// </summary>
sealed class OverlayForm : Form
{
    static readonly string Port = Environment.GetEnvironmentVariable("AGENT_WATCH_PORT") ?? "4777";
    static readonly string Origin = $"http://localhost:{Port}";
    static readonly string DataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentWatch");
    static readonly string BoundsFile = Path.Combine(DataDir, "overlay.json");

    readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(18, 14, 11) };
    readonly System.Windows.Forms.Timer _retry = new() { Interval = 3000 };
    readonly System.Windows.Forms.Timer _saveSoon = new() { Interval = 500 }; // saves the position shortly after a move
    bool _placed; // set once the saved position has been applied, so that first move is not saved back
    Process? _server; // only set when this window started the server

    public OverlayForm()
    {
        Text = "Agent Watch";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); // the dwarf from icon.ico, for Alt+Tab
        BackColor = Color.FromArgb(18, 14, 11);
        FormBorderStyle = FormBorderStyle.Sizable;
        // No maximize/minimize styles: without WS_MAXIMIZEBOX, Windows Snap leaves the window alone, so a
        // drag to the screen edge keeps its size (our own snapping lines it up) instead of tiling it to half
        // the screen, and a double-click on the bar does not maximize it.
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false; // it lives in a corner; close it with the ✕ in its bar
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Controls.Add(_web);
        _retry.Tick += async (_, _) =>
        {
            _retry.Stop();
            try { await EnsureServerAsync(); } // the server may have been stopped since: start our own
            catch (Win32Exception) { /* node could not start; the waiting page stays up */ }
            Navigate();
        };
        FormClosing += (_, _) => { SaveBounds(); StopServer(); };
        // Save as soon as it has been moved or resized (dragging, snapping, a monitor change), not only on
        // close, so the spot survives the app being killed or Windows shutting down.
        _saveSoon.Tick += (_, _) => { _saveSoon.Stop(); SaveBounds(); };
        Move += (_, _) => SaveSoon();
        Resize += (_, _) => SaveSoon();
        // The invisible resize borders are only known once the window is on screen: line it up with the
        // edges it was snapped to now (the saved spot may be from another resolution or taskbar size).
        Shown += (_, _) => ReAnchor();
    }

    void SaveSoon()
    {
        if (!_placed) return;
        _saveSoon.Stop();
        _saveSoon.Start();
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        MinimumSize = LogicalToDeviceUnits(new Size(240, 160));
        var saved = LoadBounds();
        Bounds = saved?.Rect ?? DefaultBounds();
        _anchor = saved?.Anchor ?? (Edge.Right | Edge.Bottom);
        _placed = true;
        try
        {
            await EnsureServerAsync();
            await InitWebViewAsync();
            Navigate();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Agent Watch overlay could not start:\n\n" + ex.Message, "Agent Watch",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    /* ---------- page ---------- */

    async Task InitWebViewAsync()
    {
        var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DataDir, "WebView2"));
        await _web.EnsureCoreWebView2Async(env);
        var core = _web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.IsReputationCheckingRequired = false; // local page; skip the SmartScreen lookup
        core.Settings.IsNonClientRegionSupportEnabled = true; // app-region: drag on the status bar moves the window
        core.WebMessageReceived += OnWebMessage;
        core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
        core.NavigationCompleted += (_, e) =>
        {
            if (e.IsSuccess || !core.Source.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)) return;
            // The server is not answering (yet): say so, and try again in a few seconds.
            core.NavigateToString(WaitingPage);
            _retry.Start();
        };
    }

    void Navigate() => _web.CoreWebView2?.Navigate(Origin + "/?overlay=1");

    void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            switch (root.GetProperty("type").GetString())
            {
                case "close":
                    Close();
                    break;
                case "open":
                    var hash = root.TryGetProperty("hash", out var h) ? h.GetString() ?? "" : "";
                    OpenExternal(Origin + "/" + (hash.StartsWith('#') ? hash : ""));
                    break;
            }
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            // not one of ours; ignore
        }
    }

    static void OpenExternal(string url)
    {
        if (!url.StartsWith(Origin + "/", StringComparison.OrdinalIgnoreCase)) return; // only our own page
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    static readonly string WaitingPage =
        "<html><body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#120e0b;" +
        "color:#b3a594;font:13px system-ui;app-region:drag\">Waiting for the Agent Watch server on " +
        $"localhost:{Port}…</body></html>";

    /* ---------- server ---------- */

    static async Task<bool> ServerUpAsync()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            // 127.0.0.1, not localhost: the server only listens on IPv4, and on Windows a refused
            // connection to ::1 takes about 2 s before .NET moves on to the IPv4 address.
            using var res = await http.GetAsync($"http://127.0.0.1:{Port}/api/state");
            return res.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return false;
        }
    }

    /// <summary>Starts server.js (found next to or above this program) when nothing answers on the port.</summary>
    async Task EnsureServerAsync()
    {
        if (await ServerUpAsync()) return;
        if (_server is { HasExited: false }) return; // ours is still starting up
        var script = FindServerScript();
        if (script is null) return; // the waiting page explains; start the server by hand
        _server = Process.Start(new ProcessStartInfo("node", $"\"{script}\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(script)!,
            Environment = { ["PORT"] = Port },
        });
        if (_server is not null) KillWithThisApp(_server);
        for (var i = 0; i < 20 && !await ServerUpAsync(); i++) await Task.Delay(250);
    }

    static string? FindServerScript()
    {
        var env = Environment.GetEnvironmentVariable("AGENT_WATCH_SERVER");
        if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "server.js");
            if (File.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "mine.js"))) return candidate;
        }
        return null;
    }

    void StopServer()
    {
        try
        {
            if (_server is { HasExited: false }) _server.Kill(entireProcessTree: true);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception) { /* already gone or going */ }
    }

    // A job object that ends the processes in it when this app's handle to it closes, which Windows
    // does when the app exits in any way, including being killed in Task Manager. Without it, a killed
    // overlay left its node server running on the port, and the next start would use it and never stop it.
    static IntPtr _job;

    static void KillWithThisApp(Process p)
    {
        try
        {
            if (_job == IntPtr.Zero)
            {
                var job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) return;
                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                int size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
                if (!SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, ref info, size)) return;
                _job = job; // kept open (never closed) for the life of the app
            }
            AssignProcessToJobObject(_job, p.Handle);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception) { /* exited already */ }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong Read, Write, Other, ReadBytes, WriteBytes, OtherBytes; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);

    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    /* ---------- position ---------- */

    Rectangle DefaultBounds()
    {
        // first start: bottom-right of the main screen (afterwards it reopens where it was left)
        var area = (Screen.PrimaryScreen ?? Screen.AllScreens[0]).WorkingArea;
        var size = LogicalToDeviceUnits(new Size(440, 320));
        var gap = LogicalToDeviceUnits(16);
        return new Rectangle(area.Right - size.Width - gap, area.Bottom - size.Height - gap, size.Width, size.Height);
    }

    static (Rectangle Rect, Edge Anchor)? LoadBounds()
    {
        try
        {
            var b = JsonSerializer.Deserialize<SavedBounds>(File.ReadAllText(BoundsFile));
            if (b is null) return null;
            var rect = new Rectangle(b.X, b.Y, b.Width, b.Height);
            // only if it is still (mostly) on a screen, e.g. not on a monitor that has been unplugged
            return Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(rect) &&
                Rectangle.Intersect(s.WorkingArea, rect).Width > 80) ? (rect, (Edge)b.Anchor) : null;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    void SaveBounds()
    {
        try
        {
            var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            Directory.CreateDirectory(DataDir);
            File.WriteAllText(BoundsFile, JsonSerializer.Serialize(new SavedBounds(r.X, r.Y, r.Width, r.Height, (int)_anchor)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // not worth bothering anyone about
        }
    }

    // Anchor: the screen edges it was snapped to (Edge flags); files from before snapping have none
    sealed record SavedBounds(int X, int Y, int Width, int Height, int Anchor = 0);

    /* ---------- snapping to the screen's edges and corners ---------- */
    // Dragged or resized within SnapDistance of an edge of the screen's work area (the screen minus the
    // taskbar), the window's visible frame lines up with it; near a corner it snaps to both edges. Hold
    // Alt to place it freely. The edges it ends up against are remembered, so it stays in its corner
    // when the resolution, the scaling or the taskbar changes, and when it starts again.

    [Flags]
    enum Edge { None = 0, Left = 1, Right = 2, Top = 4, Bottom = 8 }

    Edge _anchor;
    int SnapDistance => LogicalToDeviceUnits(24);

    const int WM_SIZING = 0x0214, WM_MOVING = 0x0216, WM_ENTERSIZEMOVE = 0x0231, WM_EXITSIZEMOVE = 0x0232;

    // Where a drag or resize started. Windows proposes each step as the current window plus the latest
    // mouse movement, so once snapped, a slow pull never got past the snap distance; positions are
    // worked out from the start of the drag instead, and the window lets go as soon as the pointer has.
    RECT _startRect;
    Point _startCursor;
    bool _dragging;
    const int WM_DISPLAYCHANGE = 0x007E, WM_SETTINGCHANGE = 0x001A, WM_DPICHANGED = 0x02E0, SPI_SETWORKAREA = 0x002F;

    /// <summary>How far the visible frame sits inside the window rectangle (the invisible resize borders).</summary>
    RECT Insets()
    {
        if (!GetWindowRect(Handle, out var win) ||
            DwmGetWindowAttribute(Handle, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out RECT vis, Marshal.SizeOf<RECT>()) != 0)
            return default;
        return new RECT { Left = vis.Left - win.Left, Top = vis.Top - win.Top, Right = win.Right - vis.Right, Bottom = win.Bottom - vis.Bottom };
    }

    static Rectangle WorkAreaAt(Point p) => Screen.FromPoint(p).WorkingArea;

    /// <summary>Moving: shift the whole window onto the nearest edges of the screen under the pointer.</summary>
    void SnapMove(ref RECT r)
    {
        if (!_dragging) return; // moved with the keyboard: leave Windows' steps alone
        {
            var c = Cursor.Position;
            int w = r.Right - r.Left, h = r.Bottom - r.Top;
            r.Left = _startRect.Left + c.X - _startCursor.X; r.Top = _startRect.Top + c.Y - _startCursor.Y;
            r.Right = r.Left + w; r.Bottom = r.Top + h;
        }
        if ((ModifierKeys & Keys.Alt) != 0) return;
        var ins = Insets();
        var wa = WorkAreaAt(Cursor.Position);
        int d = SnapDistance, dx = 0, dy = 0;
        int left = r.Left + ins.Left, right = r.Right - ins.Right, top = r.Top + ins.Top, bottom = r.Bottom - ins.Bottom;
        if (Math.Abs(left - wa.Left) <= d) dx = wa.Left - left;
        else if (Math.Abs(right - wa.Right) <= d) dx = wa.Right - right;
        if (Math.Abs(top - wa.Top) <= d) dy = wa.Top - top;
        else if (Math.Abs(bottom - wa.Bottom) <= d) dy = wa.Bottom - bottom;
        r.Left += dx; r.Right += dx; r.Top += dy; r.Bottom += dy;
    }

    /// <summary>Resizing: snap only the edges being dragged (wParam: WMSZ_LEFT 1 … WMSZ_BOTTOMRIGHT 8).</summary>
    void SnapSize(int side, ref RECT r)
    {
        if (!_dragging) return; // sized with the keyboard: leave Windows' steps alone
        {
            var c = Cursor.Position;
            int dx = c.X - _startCursor.X, dy = c.Y - _startCursor.Y;
            var min = MinimumSize;
            if (side is 1 or 4 or 7) r.Left = Math.Min(_startRect.Left + dx, r.Right - min.Width);
            if (side is 2 or 5 or 8) r.Right = Math.Max(_startRect.Right + dx, r.Left + min.Width);
            if (side is 3 or 4 or 5) r.Top = Math.Min(_startRect.Top + dy, r.Bottom - min.Height);
            if (side is 6 or 7 or 8) r.Bottom = Math.Max(_startRect.Bottom + dy, r.Top + min.Height);
        }
        if ((ModifierKeys & Keys.Alt) != 0) return;
        var ins = Insets();
        var wa = WorkAreaAt(Cursor.Position);
        int d = SnapDistance;
        if (side is 1 or 4 or 7 && Math.Abs(r.Left + ins.Left - wa.Left) <= d) r.Left = wa.Left - ins.Left;
        if (side is 2 or 5 or 8 && Math.Abs(r.Right - ins.Right - wa.Right) <= d) r.Right = wa.Right + ins.Right;
        if (side is 3 or 4 or 5 && Math.Abs(r.Top + ins.Top - wa.Top) <= d) r.Top = wa.Top - ins.Top;
        if (side is 6 or 7 or 8 && Math.Abs(r.Bottom - ins.Bottom - wa.Bottom) <= d) r.Bottom = wa.Bottom + ins.Bottom;
    }

    /// <summary>Which work-area edges the visible frame touches right now.</summary>
    Edge TouchingEdges()
    {
        var ins = Insets();
        var b = Bounds;
        var wa = Screen.FromRectangle(b).WorkingArea;
        var e = Edge.None;
        if (Math.Abs(b.Left + ins.Left - wa.Left) <= 1) e |= Edge.Left;
        else if (Math.Abs(b.Right - ins.Right - wa.Right) <= 1) e |= Edge.Right;
        if (Math.Abs(b.Top + ins.Top - wa.Top) <= 1) e |= Edge.Top;
        else if (Math.Abs(b.Bottom - ins.Bottom - wa.Bottom) <= 1) e |= Edge.Bottom;
        return e;
    }

    /// <summary>Puts the window back against the edges it was snapped to, on its current screen.</summary>
    void ReAnchor()
    {
        if (_dragging || _anchor == Edge.None || WindowState != FormWindowState.Normal) return; // never mid-drag
        var ins = Insets();
        var b = Bounds;
        var wa = Screen.FromRectangle(b).WorkingArea;
        int x = b.X, y = b.Y;
        if (_anchor.HasFlag(Edge.Left)) x = wa.Left - ins.Left;
        else if (_anchor.HasFlag(Edge.Right)) x = wa.Right + ins.Right - b.Width;
        if (_anchor.HasFlag(Edge.Top)) y = wa.Top - ins.Top;
        else if (_anchor.HasFlag(Edge.Bottom)) y = wa.Bottom + ins.Bottom - b.Height;
        if (x != b.X || y != b.Y) Location = new Point(x, y);
    }

    /* ---------- no caption, normal frame ---------- */

    const int WM_NCCALCSIZE = 0x0083;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Recalculate the frame now, so the caption is gone from the first paint.
        SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0020);
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            case WM_MOVING:
            case WM_SIZING:
                var r = Marshal.PtrToStructure<RECT>(m.LParam);
                if (m.Msg == WM_MOVING) SnapMove(ref r); else SnapSize((int)m.WParam, ref r);
                Marshal.StructureToPtr(r, m.LParam, false);
                m.Result = (IntPtr)1;
                return;
            case WM_ENTERSIZEMOVE:
                // A mouse drag holds a button down; Alt+Space → Move/Size does not. (Physical buttons,
                // either one, so it also works with swapped buttons and while WebView2 owns the click.)
                _dragging = (GetAsyncKeyState(0x01) < 0 || GetAsyncKeyState(0x02) < 0) && GetWindowRect(Handle, out _startRect);
                _startCursor = Cursor.Position;
                break;
            case WM_EXITSIZEMOVE: // a drag or resize ended: remember what it is snapped to
                _dragging = false;
                _anchor = TouchingEdges();
                SaveSoon();
                break;
            case WM_DPICHANGED when _dragging:
                // dragged onto a monitor with other scaling: Windows resizes the window around the pointer
                // (lParam); carry on from there, or the window would keep the old offset from the pointer
                base.WndProc(ref m);
                _startRect = Marshal.PtrToStructure<RECT>(m.LParam);
                _startCursor = Cursor.Position;
                return;
            case WM_DISPLAYCHANGE:
            case WM_DPICHANGED:
            case WM_SETTINGCHANGE when (int)m.WParam == SPI_SETWORKAREA:
                base.WndProc(ref m);
                BeginInvoke(ReAnchor); // after Windows has moved things around
                return;
        }
        if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
        {
            // Let Windows compute the normal frame, then give the caption area back to the page.
            var top = Marshal.PtrToStructure<RECT>(m.LParam).Top;
            base.WndProc(ref m);
            var rect = Marshal.PtrToStructure<RECT>(m.LParam);
            rect.Top = top;
            Marshal.StructureToPtr(rect, m.LParam, false);
            m.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref m);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int key);

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
