namespace AgentWatch.Overlay;

static class Program
{
    [STAThread]
    static void Main()
    {
        // One overlay at a time: starting it again does nothing while one is open.
        using var single = new Mutex(true, @"Local\AgentWatch.Overlay", out var first);
        if (!first) return;
        ApplicationConfiguration.Initialize();
        Application.Run(new OverlayForm());
    }
}
