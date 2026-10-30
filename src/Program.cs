using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace WinVR
{
    // =========================================================================
    // Win32 Native Interop for Mouse Simulation
    // =========================================================================
    public static class Win32
    {
        [DllImport("user32.dll")]
        public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;

        public static void InjectMouseMove(int dx, int dy)
        {
            mouse_event(MOUSEEVENTF_MOVE, dx, dy, 0, UIntPtr.Zero);
        }

        public static void InjectLeftClick()
        {
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(20);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        }
    }

    // =========================================================================
    // High-Precision Gyroscope to Mouse Smoothing & Deadzone Engine
    // =========================================================================
    public class MouseEngine
    {
        public bool MouseLookEnabled = false; // Default OFF to protect desktop from accidental movements
        public double YawSensitivity = 2.0;
        public double PitchSensitivity = 1.8;
        public double Smoothing = 0.0; // 0.0 (raw instant gaming) to 0.85 (smooth cinema)
        public double Deadzone = 0.003;  // deg threshold
        public double NoiseFloor = 0.008; // deg stationary noise floor to eliminate creeping drift
        public bool InvertX = false;
        public bool InvertY = false;

        private double _smoothDx = 0.0;
        private double _smoothDy = 0.0;
        private double _accumX = 0.0;
        private double _accumY = 0.0;
        private readonly object _lock = new object();

        public void ProcessGyroDelta(double rawDx, double rawDy)
        {
            if (!MouseLookEnabled) return;

            lock (_lock)
            {
                // 1. Stationary Noise Floor & Decay Check:
                // When head is held still or resting on desk, sensor flutter is below NoiseFloor.
                // Decaying accumulators guarantees sub-pixel noise can NEVER accumulate into a creeping mouse step!
                if (Math.Abs(rawDx) <= NoiseFloor && Math.Abs(rawDy) <= NoiseFloor)
                {
                    _accumX *= 0.80;
                    _accumY *= 0.80;
                    if (Math.Abs(_accumX) < 0.005) _accumX = 0.0;
                    if (Math.Abs(_accumY) < 0.005) _accumY = 0.0;
                    _smoothDx *= 0.80;
                    _smoothDy *= 0.80;
                    return;
                }

                // 2. Continuous Deadzone Subtraction:
                // Subtracting deadzone provides C0 continuity so intentional movement ramps smoothly from 0
                double effectiveDx = Math.Sign(rawDx) * Math.Max(0.0, Math.Abs(rawDx) - Deadzone);
                double effectiveDy = Math.Sign(rawDy) * Math.Max(0.0, Math.Abs(rawDy) - Deadzone);

                // 3. Ultra-Low Latency Mode: if smoothing is near-zero, bypass filter completely
                if (Smoothing > 0.005)
                {
                    double alpha = 1.0 - Math.Min(0.95, Math.Max(0.0, Smoothing));
                    _smoothDx = (alpha * effectiveDx) + ((1.0 - alpha) * _smoothDx);
                    _smoothDy = (alpha * effectiveDy) + ((1.0 - alpha) * _smoothDy);
                    effectiveDx = _smoothDx;
                    effectiveDy = _smoothDy;
                }

                // Natural 1:1 VR Head Look:
                // Turning head right -> moves mouse right (positive X)
                // Tilting head up -> moves mouse up (negative Y in Windows screen coords)
                double scaledX = -effectiveDx * YawSensitivity * 18.0;
                double scaledY = -effectiveDy * PitchSensitivity * 18.0;

                if (InvertX) scaledX = -scaledX;
                if (InvertY) scaledY = -scaledY;

                // Sub-pixel Accumulator
                _accumX += scaledX;
                _accumY += scaledY;

                int stepX = (int)_accumX;
                int stepY = (int)_accumY;

                _accumX -= stepX;
                _accumY -= stepY;

                if (stepX != 0 || stepY != 0)
                {
                    Win32.InjectMouseMove(stepX, stepY);
                }
            }
        }

        public void Reset()
        {
            lock (_lock)
            {
                _smoothDx = 0.0;
                _smoothDy = 0.0;
                _accumX = 0.0;
                _accumY = 0.0;
            }
        }

        public double GetAccumX() { lock (_lock) { return _accumX; } }
        public double GetAccumY() { lock (_lock) { return _accumY; } }
    }

    // =========================================================================
    // High-Performance Socket Buffer & Latency Optimizer
    // =========================================================================
    public static class SocketOptimizer
    {
        public const int TargetBufferSize = 16 * 1024 * 1024; // 16 MB max OS limit

        public static void ConfigureSocket(Socket socket)
        {
            if (socket == null) return;
            try
            {
                if (socket.SocketType == SocketType.Stream)
                {
                    socket.NoDelay = true;
                }
            }
            catch { }

            // Force maximum OS socket buffer sizes (16MB down to 1MB fallback)
            int[] bufferSizes = new int[] { TargetBufferSize, 8 * 1024 * 1024, 4 * 1024 * 1024, 1024 * 1024 };
            foreach (int size in bufferSizes)
            {
                try
                {
                    socket.SendBufferSize = size;
                    socket.ReceiveBufferSize = size;
                    break;
                }
                catch { }
            }

            try
            {
                socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            }
            catch { }

            if (socket.SocketType == SocketType.Stream)
            {
                try
                {
                    socket.LingerState = new LingerOption(false, 0);
                }
                catch { }
            }
        }
    }

    // =========================================================================
    // Ultra-Fast Asynchronous UDP Datagram Server (Port 8082)
    // =========================================================================
    public class WinVRUdpServer
    {
        private readonly int _port;
        private readonly WinVRServer _server;
        private UdpClient _udpClient;
        private bool _running = false;
        private readonly JavaScriptSerializer _serializer = new JavaScriptSerializer();

        public WinVRUdpServer(int port, WinVRServer server)
        {
            _port = port;
            _server = server;
        }

        public void Start()
        {
            try
            {
                _udpClient = new UdpClient();
                SocketOptimizer.ConfigureSocket(_udpClient.Client);
                _udpClient.Client.Bind(new IPEndPoint(IPAddress.Any, _port));
                _running = true;
                _server.Log(string.Format("UDP Fast Stream Engine active on port {0} (16MB Buffers)", _port));

                Thread udpWorker = new Thread(ReceiveLoop)
                {
                    IsBackground = true,
                    Name = "WinVR_UDP_Worker"
                };
                udpWorker.Start();
            }
            catch (Exception ex)
            {
                _server.Log("Failed to start UDP Server: " + ex.Message);
            }
        }

        public void Stop()
        {
            _running = false;
            try { _udpClient.Close(); } catch { }
        }

        private void ReceiveLoop()
        {
            IPEndPoint remoteEP = new IPEndPoint(IPAddress.Any, 0);
            while (_running)
            {
                try
                {
                    byte[] data = _udpClient.Receive(ref remoteEP);
                    if (data == null || data.Length == 0) continue;

                    byte[] packet = data;
                    IPEndPoint sender = remoteEP;
                    ThreadPool.QueueUserWorkItem(_ => ProcessPacket(packet, sender));
                }
                catch (SocketException)
                {
                    if (!_running) break;
                }
                catch (Exception)
                {
                    if (!_running) break;
                }
            }
        }

        private void ProcessPacket(byte[] data, IPEndPoint sender)
        {
            try
            {
                string text = Encoding.UTF8.GetString(data);
                var dict = _serializer.Deserialize<Dictionary<string, object>>(text);
                if (dict == null || !dict.ContainsKey("type")) return;
                string type = dict["type"].ToString();

                if (type == "gyro_delta")
                {
                    double dx = Convert.ToDouble(dict["dx"]);
                    double dy = Convert.ToDouble(dict["dy"]);
                    _server.Mouse.ProcessGyroDelta(dx, dy);
                    Interlocked.Increment(ref _server.GyroPacketCount);

                    // Throttle visual telemetry to PC host visualizer to 20 FPS (every 50ms) to avoid saturating loopback socket
                    long nowTicks = DateTime.UtcNow.Ticks;
                    if (_server.HostClient != null && (nowTicks - _server.LastVisualSendTicks) >= 500000) // 50ms
                    {
                        _server.LastVisualSendTicks = nowTicks;
                        _server.HostClient.Send(string.Format("{{\"type\":\"gyro_visual\",\"dx\":{0},\"dy\":{1}}}", dx, dy));
                    }
                }
                else if (type == "recenter")
                {
                    _server.Mouse.Reset();
                    _server.Log("UDP: Recenter command received.");
                }
                else if (type == "ping")
                {
                    byte[] pong = Encoding.UTF8.GetBytes("{\"type\":\"pong\",\"time\":" + DateTime.UtcNow.Ticks + "}");
                    _udpClient.Send(pong, pong.Length, sender);
                }
            }
            catch { }
        }
    }

    // =========================================================================
    // Dual HTTP (8080) & HTTPS (8443) Server with WebSocket RFC 6455
    // =========================================================================
    public class WinVRServer
    {
        private TcpListener _httpListener;
        private TcpListener _httpsListener;
        private WinVRUdpServer _udpServer;
        private bool _running = false;
        private int _httpPort;
        private readonly int _httpsPort;
        private readonly int _udpPort = 8082;
        private readonly string _webRoot;
        private readonly X509Certificate2 _cert;
        private readonly JavaScriptSerializer _serializer = new JavaScriptSerializer();
        public readonly MouseEngine Mouse = new MouseEngine();

        // WebSocket clients
        private readonly List<WebSocketClient> _clients = new List<WebSocketClient>();
        private WebSocketClient _hostClient = null;
        private WebSocketClient _phoneClient = null;
        private readonly object _clientsLock = new object();

        public int HttpPort { get { return _httpPort; } }
        public int HttpsPort { get { return _httpsPort; } }
        public WebSocketClient HostClient { get { return _hostClient; } }
        public WebSocketClient PhoneClient { get { return _phoneClient; } }
        public int UdpPort { get { return _udpPort; } }

        // Gyro telemetry tracking
        public long GyroPacketCount = 0;
        private long _lastPacketCount = 0;
        private DateTime _lastRateCheck = DateTime.Now;
        public long LastVisualSendTicks = 0;
        public long LastLatencyAckTicks = 0;
        public long LastMotionArrivalTicks = 0;

        public event Action<string> OnLog;
        public event Action<int, double> OnStatsUpdated;

        public WinVRServer(int httpPort, int httpsPort, string webRoot, X509Certificate2 cert)
        {
            _httpPort = httpPort;
            _httpsPort = httpsPort;
            _webRoot = webRoot;
            _cert = cert;
        }

        public void Start()
        {
            _running = true;

            // 1. HTTP Listener with automatic port fallback if 8080 is reserved/in-use
            int[] candidates = new int[] { _httpPort, 8081, 8085, 8000, 8888, 5000 };
            bool bound = false;
            foreach (int port in candidates)
            {
                try
                {
                    _httpListener = new TcpListener(IPAddress.Any, port);
                    _httpListener.Start();
                    _httpPort = port;
                    bound = true;
                    Log(string.Format("HTTP Server active on port {0} (TCP_NODELAY + 16MB Buffers)", _httpPort));

                    Thread httpThread = new Thread(AcceptHttpLoop);
                    httpThread.IsBackground = true;
                    httpThread.Start();
                    break;
                }
                catch (Exception ex)
                {
                    Log(string.Format("Port {0} not available ({1}), trying next port...", port, ex.Message));
                    try { if (_httpListener != null) _httpListener.Stop(); } catch { }
                    _httpListener = null;
                }
            }

            if (!bound)
            {
                Log("Warning: Could not bind any HTTP port. Secure HTTPS is still active on port " + _httpsPort);
            }

            // 2. HTTPS Listener (if cert available)
            if (_cert != null)
            {
                try
                {
                    _httpsListener = new TcpListener(IPAddress.Any, _httpsPort);
                    _httpsListener.Start();
                    Log(string.Format("HTTPS Secure Server active on port {0} (SSL/TLS + 16MB Buffers)", _httpsPort));

                    Thread httpsThread = new Thread(AcceptHttpsLoop);
                    httpsThread.IsBackground = true;
                    httpsThread.Start();
                }
                catch (Exception ex)
                {
                    Log("Failed to start HTTPS listener: " + ex.Message);
                }
            }

            // 3. UDP Fast Stream Listener
            try
            {
                _udpServer = new WinVRUdpServer(_udpPort, this);
                _udpServer.Start();
            }
            catch (Exception ex)
            {
                Log("Failed to start UDP server: " + ex.Message);
            }

            // Stats monitor thread
            Thread statsThread = new Thread(StatsLoop);
            statsThread.IsBackground = true;
            statsThread.Start();
        }

        public void Stop()
        {
            _running = false;
            try { if (_httpListener != null) _httpListener.Stop(); } catch { }
            try { if (_httpsListener != null) _httpsListener.Stop(); } catch { }
            try { if (_udpServer != null) _udpServer.Stop(); } catch { }
            lock (_clientsLock)
            {
                foreach (var c in _clients) c.Close();
                _clients.Clear();
            }
            Log("WinVR Server stopped.");
        }

        public void Log(string msg)
        {
            string line = string.Format("[{0:HH:mm:ss}] {1}", DateTime.Now, msg);
            if (OnLog != null) OnLog(line);
            Console.WriteLine(line);
        }

        private void AcceptHttpLoop()
        {
            while (_running)
            {
                try
                {
                    TcpClient tcp = _httpListener.AcceptTcpClient();
                    SocketOptimizer.ConfigureSocket(tcp.Client);
                    Thread t = new Thread(() => HandleClient(tcp, null));
                    t.IsBackground = true;
                    t.Start();
                }
                catch { if (!_running) break; }
            }
        }

        private void AcceptHttpsLoop()
        {
            while (_running)
            {
                try
                {
                    TcpClient tcp = _httpsListener.AcceptTcpClient();
                    SocketOptimizer.ConfigureSocket(tcp.Client);
                    Thread t = new Thread(() => {
                        try
                        {
                            SslStream ssl = new SslStream(tcp.GetStream(), false);
                            ssl.AuthenticateAsServer(_cert, false, SslProtocols.Tls12 | SslProtocols.Tls11 | SslProtocols.Tls, false);
                            HandleClient(tcp, ssl);
                        }
                        catch
                        {
                            try { tcp.Close(); } catch { }
                        }
                    });
                    t.IsBackground = true;
                    t.Start();
                }
                catch { if (!_running) break; }
            }
        }

        private void HandleClient(TcpClient tcp, SslStream ssl)
        {
            Stream stream = (Stream)ssl ?? tcp.GetStream();
            try
            {
                byte[] buffer = new byte[8192];
                int bytesRead = stream.Read(buffer, 0, buffer.Length);
                if (bytesRead <= 0) { tcp.Close(); return; }

                string request = Encoding.UTF8.GetString(buffer, 0, bytesRead);
                string[] lines = request.Split(new string[] { "\r\n" }, StringSplitOptions.None);
                if (lines.Length == 0) { tcp.Close(); return; }

                string[] reqLine = lines[0].Split(' ');
                if (reqLine.Length < 2) { tcp.Close(); return; }

                string method = reqLine[0];
                string path = reqLine[1];

                // WebSocket Upgrade Check
                bool isWsUpgrade = false;
                string wsKey = null;
                for (int i = 1; i < lines.Length; i++)
                {
                    if (lines[i].StartsWith("Upgrade:", StringComparison.OrdinalIgnoreCase) &&
                        lines[i].IndexOf("websocket", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        isWsUpgrade = true;
                    }
                    else if (lines[i].StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase))
                    {
                        wsKey = lines[i].Substring("Sec-WebSocket-Key:".Length).Trim();
                    }
                }

                if (isWsUpgrade && wsKey != null)
                {
                    DoWebSocketHandshake(stream, wsKey);
                    WebSocketClient wsClient = new WebSocketClient(tcp, stream, this);
                    lock (_clientsLock)
                    {
                        _clients.Add(wsClient);
                    }
                    wsClient.ProcessLoop();
                    return;
                }

                // HTTP GET
                ServeHttp(stream, path);
            }
            catch
            {
                // Connection closed or reset
            }
            finally
            {
                try { tcp.Close(); } catch { }
            }
        }

        private void DoWebSocketHandshake(Stream stream, string secWebSocketKey)
        {
            string magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
            string acceptKey;
            using (SHA1 sha1 = SHA1.Create())
            {
                byte[] hash = sha1.ComputeHash(Encoding.UTF8.GetBytes(secWebSocketKey + magic));
                acceptKey = Convert.ToBase64String(hash);
            }

            string response = "HTTP/1.1 101 Switching Protocols\r\n" +
                              "Upgrade: websocket\r\n" +
                              "Connection: Upgrade\r\n" +
                              "Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n";
            byte[] respBytes = Encoding.UTF8.GetBytes(response);
            stream.Write(respBytes, 0, respBytes.Length);
            stream.Flush();
        }

        private byte[] LoadAssetBytes(string relativePath)
        {
            // 1. Try disk file first if it exists
            if (!string.IsNullOrEmpty(_webRoot))
            {
                string diskPath = Path.Combine(_webRoot, relativePath.TrimStart('/', '\\'));
                if (File.Exists(diskPath))
                {
                    try { return File.ReadAllBytes(diskPath); } catch { }
                }
            }

            // 2. Try Embedded Resource fallback
            string normalized = relativePath.TrimStart('/', '\\').Replace('\\', '/');
            string resName = "web." + normalized.Replace('/', '.');
            using (Stream s = typeof(Program).Assembly.GetManifestResourceStream(resName))
            {
                if (s != null)
                {
                    byte[] data = new byte[s.Length];
                    int totalRead = 0;
                    while (totalRead < data.Length)
                    {
                        int read = s.Read(data, totalRead, data.Length - totalRead);
                        if (read <= 0) break;
                        totalRead += read;
                    }
                    return data;
                }
            }

            // 3. Try direct resource name
            using (Stream s = typeof(Program).Assembly.GetManifestResourceStream(normalized))
            {
                if (s != null)
                {
                    byte[] data = new byte[s.Length];
                    int totalRead = 0;
                    while (totalRead < data.Length)
                    {
                        int read = s.Read(data, totalRead, data.Length - totalRead);
                        if (read <= 0) break;
                        totalRead += read;
                    }
                    return data;
                }
            }

            return null;
        }

        private void ServeHttp(Stream stream, string urlPath)
        {
            if (string.IsNullOrEmpty(urlPath)) urlPath = "/";

            // Strip query string and fragment
            int qIdx = urlPath.IndexOf('?');
            if (qIdx >= 0) urlPath = urlPath.Substring(0, qIdx);
            int hIdx = urlPath.IndexOf('#');
            if (hIdx >= 0) urlPath = urlPath.Substring(0, hIdx);

            urlPath = urlPath.Trim();

            // API Endpoint returning IP & Ports
            if (urlPath.StartsWith("/api/ip", StringComparison.OrdinalIgnoreCase))
            {
                string localIp = DiscoverLocalIP();
                string json = string.Format("{{\"ip\":\"{0}\",\"httpPort\":{1},\"httpsPort\":{2},\"udpPort\":{3},\"httpUrl\":\"http://{0}:{1}/vr\",\"httpsUrl\":\"https://{0}:{2}/vr\"}}",
                    localIp, _httpPort, _httpsPort, _udpPort);
                byte[] content = Encoding.UTF8.GetBytes(json);
                SendHttpResponse(stream, 200, "OK", "application/json", content);
                return;
            }

            // Normalize URL aliases for Dashboard
            string cleanPath = urlPath.TrimStart('/');
            if (cleanPath == "" ||
                cleanPath.Equals("index.html", StringComparison.OrdinalIgnoreCase) ||
                cleanPath.Equals("index", StringComparison.OrdinalIgnoreCase) ||
                cleanPath.Equals("dashboard", StringComparison.OrdinalIgnoreCase) ||
                cleanPath.Equals("host", StringComparison.OrdinalIgnoreCase) ||
                cleanPath.Equals("pc", StringComparison.OrdinalIgnoreCase) ||
                cleanPath.Equals("web", StringComparison.OrdinalIgnoreCase) ||
                cleanPath.Equals("web/index.html", StringComparison.OrdinalIgnoreCase))
            {
                cleanPath = "index.html";
            }
            // Normalize URL aliases for VR Mobile client
            else if (cleanPath.Equals("vr", StringComparison.OrdinalIgnoreCase) ||
                     cleanPath.Equals("vr.html", StringComparison.OrdinalIgnoreCase) ||
                     cleanPath.Equals("client", StringComparison.OrdinalIgnoreCase) ||
                     cleanPath.Equals("phone", StringComparison.OrdinalIgnoreCase) ||
                     cleanPath.Equals("mobile", StringComparison.OrdinalIgnoreCase) ||
                     cleanPath.Equals("headset", StringComparison.OrdinalIgnoreCase) ||
                     cleanPath.Equals("web/vr.html", StringComparison.OrdinalIgnoreCase))
            {
                cleanPath = "vr.html";
            }
            else if (cleanPath.StartsWith("web/", StringComparison.OrdinalIgnoreCase))
            {
                cleanPath = cleanPath.Substring(4);
            }

            byte[] fileBytes = LoadAssetBytes(cleanPath);
            if (fileBytes != null && fileBytes.Length > 0)
            {
                string mime = GetMimeType(cleanPath);
                SendHttpResponse(stream, 200, "OK", mime, fileBytes);
            }
            else
            {
                string notFoundHtml = string.Format(
                    "<!DOCTYPE html><html><head><title>WinVR - Page Not Found</title>" +
                    "<style>body{{font-family:sans-serif;background:#0a0d14;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;}}" +
                    "h1{{color:#00f2fe;margin-bottom:8px;}}p{{color:#94a3b8;margin-bottom:24px;}}a{{background:#0072ff;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;}}</style></head>" +
                    "<body><h1>404 - WinVR Resource Not Found</h1><p>The requested path <code>{0}</code> could not be located.</p><a href=\"/\">Return to PC Dashboard</a></body></html>",
                    urlPath);
                byte[] notFound = Encoding.UTF8.GetBytes(notFoundHtml);
                SendHttpResponse(stream, 404, "Not Found", "text/html", notFound);
            }
        }

        private void SendHttpResponse(Stream stream, int code, string status, string mime, byte[] body)
        {
            string header = string.Format("HTTP/1.1 {0} {1}\r\n" +
                                          "Content-Type: {2}\r\n" +
                                          "Content-Length: {3}\r\n" +
                                          "Access-Control-Allow-Origin: *\r\n" +
                                          "Connection: close\r\n\r\n", code, status, mime, body.Length);
            byte[] headerBytes = Encoding.UTF8.GetBytes(header);
            stream.Write(headerBytes, 0, headerBytes.Length);
            stream.Write(body, 0, body.Length);
            stream.Flush();
        }

        private string GetMimeType(string path)
        {
            string ext = Path.GetExtension(path).ToLower();
            switch (ext)
            {
                case ".html": return "text/html; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".js": return "application/javascript; charset=utf-8";
                case ".json": return "application/json";
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".svg": return "image/svg+xml";
                default: return "application/octet-stream";
            }
        }

        public void HandleWebSocketMessage(WebSocketClient client, string message)
        {
            if (string.IsNullOrEmpty(message)) return;

            // Ultra-Fast Zero-Allocation Direct Motion Path: "G,dx,dy" or "G,dx,dy,clientTs"
            if (message.Length >= 2 && message[0] == 'G' && message[1] == ',')
            {
                try
                {
                    string[] parts = message.Split(',');
                    if (parts.Length >= 3)
                    {
                        double dx, dy;
                        if (double.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out dx) &&
                            double.TryParse(parts[2], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out dy))
                        {
                            long nowTicks = DateTime.UtcNow.Ticks;

                            // Burst protection: if packets arrived in < 2ms (TCP buffer burst flush after Wi-Fi jitter pause),
                            // clamp maximum delta to prevent violent camera whipping
                            if (LastMotionArrivalTicks > 0)
                            {
                                long elapsedTicks = nowTicks - LastMotionArrivalTicks;
                                if (elapsedTicks < 20000) // < 2ms burst flush
                                {
                                    const double maxBurstDelta = 1.2; // max degrees per burst tick
                                    dx = Math.Max(-maxBurstDelta, Math.Min(maxBurstDelta, dx));
                                    dy = Math.Max(-maxBurstDelta, Math.Min(maxBurstDelta, dy));
                                }
                            }
                            LastMotionArrivalTicks = nowTicks;

                            Mouse.ProcessGyroDelta(dx, dy);
                            Interlocked.Increment(ref GyroPacketCount);

                            // Periodically echo latency acknowledgment (every ~80ms) for client RTT calculation
                            if (parts.Length >= 4)
                            {
                                if ((nowTicks - LastLatencyAckTicks) >= 800000) // 80ms
                                {
                                    LastLatencyAckTicks = nowTicks;
                                    client.Send(string.Format("{{\"type\":\"gyro_ack\",\"clientTs\":{0},\"serverTs\":{1}}}", parts[3], nowTicks / 10000));
                                }
                            }

                            // Throttle visual telemetry to PC host visualizer to 20 FPS (every 50ms) to avoid saturating loopback socket
                            long nowVisualTicks = DateTime.UtcNow.Ticks;
                            if (_hostClient != null && (nowVisualTicks - LastVisualSendTicks) >= 500000) // 50ms
                            {
                                LastVisualSendTicks = nowVisualTicks;
                                _hostClient.Send(string.Format("{{\"type\":\"gyro_visual\",\"dx\":{0},\"dy\":{1}}}",
                                    dx.ToString("F4", System.Globalization.CultureInfo.InvariantCulture),
                                    dy.ToString("F4", System.Globalization.CultureInfo.InvariantCulture)));
                            }
                        }
                    }
                }
                catch { }
                return;
            }

            try
            {
                var data = _serializer.Deserialize<Dictionary<string, object>>(message);
                if (!data.ContainsKey("type")) return;
                string type = data["type"].ToString();

                if (type == "register")
                {
                    string role = data.ContainsKey("role") ? data["role"].ToString() : "unknown";
                    client.Role = role;

                    if (role == "host")
                    {
                        _hostClient = client;
                        Log("PC Host Dashboard registered.");
                        if (_phoneClient != null)
                        {
                            _hostClient.Send("{\"type\":\"client_connected\"}");
                        }
                    }
                    else if (role == "client")
                    {
                        _phoneClient = client;
                        Log("Phone VR Client connected!");
                        _phoneClient.Send("{\"type\":\"server_ready\",\"fastMotion\":true}");
                        if (_hostClient != null)
                        {
                            _hostClient.Send("{\"type\":\"client_connected\"}");
                        }
                    }
                }
                else if (type == "tune_vr" || type == "set_mode" || type == "remote_recenter" || type == "toggle_crosshair" || type == "tune_crosshair" || type == "save_calibration" || type == "set_fps" || type == "target_fps" || type == "stream_swapped" || type == "stream_stopped" || type == "reset_peer" || type == "webrtc_client_stats" || type == "webrtc_host_stats")
                {
                    // Relay live tuning and stream lifecycle commands between PC Host and Mobile VR Client
                    if (client == _hostClient && _phoneClient != null)
                    {
                        _phoneClient.Send(message);
                    }
                    else if (client == _phoneClient && _hostClient != null)
                    {
                        _hostClient.Send(message);
                    }
                    else if (_phoneClient != null && client != _phoneClient)
                    {
                        _phoneClient.Send(message);
                    }
                }
                else if (type == "signal")
                {
                    string target = data.ContainsKey("target") ? data["target"].ToString() : "";
                    if (target == "client" && _phoneClient != null) _phoneClient.Send(message);
                    else if (target == "host" && _hostClient != null) _hostClient.Send(message);
                }
                else if (type == "host_ready")
                {
                    if (_phoneClient != null) _phoneClient.Send(message);
                }
                else if (type == "client_resumed")
                {
                    Log("📱 Mobile VR Client resumed from background.");
                    if (_hostClient != null) _hostClient.Send(message);
                }
                else if (type == "request_keyframe")
                {
                    Log("🔄 Video keyframe requested by VR client.");
                    if (_hostClient != null) _hostClient.Send(message);
                }
                else if (type == "gyro_delta")
                {
                    double dx = Convert.ToDouble(data["dx"]);
                    double dy = Convert.ToDouble(data["dy"]);
                    Mouse.ProcessGyroDelta(dx, dy);

                    Interlocked.Increment(ref GyroPacketCount);

                    // Throttle visual telemetry to PC host visualizer to 20 FPS (every 50ms) to avoid saturating loopback socket
                    long nowTicks = DateTime.UtcNow.Ticks;
                    if (_hostClient != null && (nowTicks - LastVisualSendTicks) >= 500000) // 50ms
                    {
                        LastVisualSendTicks = nowTicks;
                        _hostClient.Send(string.Format("{{\"type\":\"gyro_visual\",\"dx\":{0},\"dy\":{1}}}", dx, dy));
                    }
                }
                else if (type == "test_mouse_move")
                {
                    int tdx = Convert.ToInt32(data["dx"]);
                    int tdy = Convert.ToInt32(data["dy"]);
                    Win32.InjectMouseMove(tdx, tdy);
                    Log(string.Format("Test mouse movement executed: dx={0}, dy={1}", tdx, tdy));
                }
                else if (type == "mouse_click")
                {
                    Win32.InjectLeftClick();
                    Log("Phone triggered Left Click.");
                }
                else if (type == "recenter")
                {
                    Mouse.Reset();
                    Log("Orientation reset / recentered.");
                }
                else if (type == "config")
                {
                    if (data.ContainsKey("config"))
                    {
                        var cfg = (Dictionary<string, object>)data["config"];
                        if (cfg.ContainsKey("mouseLookEnabled")) Mouse.MouseLookEnabled = Convert.ToBoolean(cfg["mouseLookEnabled"]);
                        if (cfg.ContainsKey("yawSensitivity")) Mouse.YawSensitivity = Convert.ToDouble(cfg["yawSensitivity"]);
                        if (cfg.ContainsKey("pitchSensitivity")) Mouse.PitchSensitivity = Convert.ToDouble(cfg["pitchSensitivity"]);
                        if (cfg.ContainsKey("smoothing")) Mouse.Smoothing = Convert.ToDouble(cfg["smoothing"]);
                        if (cfg.ContainsKey("deadzone")) Mouse.Deadzone = Convert.ToDouble(cfg["deadzone"]);
                        if (cfg.ContainsKey("noiseFloor")) Mouse.NoiseFloor = Convert.ToDouble(cfg["noiseFloor"]);
                        if (cfg.ContainsKey("invertX")) Mouse.InvertX = Convert.ToBoolean(cfg["invertX"]);
                        if (cfg.ContainsKey("invertY")) Mouse.InvertY = Convert.ToBoolean(cfg["invertY"]);
                    }
                }
            }
            catch
            {
                // Handle parsing error
            }
        }

        public void RemoveClient(WebSocketClient client)
        {
            lock (_clientsLock)
            {
                _clients.Remove(client);
                if (client == _hostClient) _hostClient = null;
                if (client == _phoneClient)
                {
                    _phoneClient = null;
                    if (_hostClient != null) _hostClient.Send("{\"type\":\"client_disconnected\"}");
                }
            }
        }

        private void StatsLoop()
        {
            while (_running)
            {
                Thread.Sleep(1000);
                long current = Interlocked.Read(ref GyroPacketCount);
                double elapsed = (DateTime.Now - _lastRateCheck).TotalSeconds;
                double rate = (current - _lastPacketCount) / (elapsed > 0 ? elapsed : 1.0);
                _lastPacketCount = current;
                _lastRateCheck = DateTime.Now;

                int count;
                lock (_clientsLock) { count = _clients.Count; }

                if (OnStatsUpdated != null)
                {
                    OnStatsUpdated(count, rate);
                }

                if (_hostClient != null)
                {
                    _hostClient.Send(string.Format("{{\"type\":\"stats_update\",\"gyroRate\":{0:F1},\"clients\":{1}}}", rate, count));
                }
            }
        }

        public static string DiscoverLocalIP()
        {
            string fallback = "127.0.0.1";
            try
            {
                foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus == OperationalStatus.Up &&
                        (ni.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 ||
                         ni.NetworkInterfaceType == NetworkInterfaceType.Ethernet))
                    {
                        foreach (UnicastIPAddressInformation ip in ni.GetIPProperties().UnicastAddresses)
                        {
                            if (ip.Address.AddressFamily == AddressFamily.InterNetwork &&
                                !IPAddress.IsLoopback(ip.Address) &&
                                !ip.Address.ToString().StartsWith("169.254"))
                            {
                                return ip.Address.ToString();
                            }
                        }
                    }
                }
            }
            catch { }
            return fallback;
        }
    }

    // =========================================================================
    // RFC 6455 WebSocket Client Session with Asynchronous Worker Queue
    // =========================================================================
    public class WebSocketClient
    {
        private readonly TcpClient _tcp;
        private readonly Stream _stream;
        private readonly WinVRServer _server;
        public string Role = "unknown";

        // Dedicated asynchronous non-blocking worker queue
        private readonly Queue<byte[]> _sendQueue = new Queue<byte[]>();
        private readonly object _sendLock = new object();
        private readonly AutoResetEvent _sendSignal = new AutoResetEvent(false);
        private readonly Thread _sendWorkerThread;
        private volatile bool _running = true;

        public WebSocketClient(TcpClient tcp, Stream stream, WinVRServer server)
        {
            _tcp = tcp;
            SocketOptimizer.ConfigureSocket(_tcp.Client);
            _stream = stream;
            _server = server;

            _sendWorkerThread = new Thread(SendWorkerLoop)
            {
                IsBackground = true,
                Name = "WinVR_WS_Sender"
            };
            _sendWorkerThread.Start();
        }

        private void SendWorkerLoop()
        {
            while (_running)
            {
                byte[] frame = null;
                lock (_sendLock)
                {
                    if (_sendQueue.Count > 0)
                    {
                        frame = _sendQueue.Dequeue();
                    }
                }

                if (frame != null)
                {
                    try
                    {
                        // Optimize data payloads into MTU-friendly chunks between 1400 and 7680 bytes
                        int offset = 0;
                        int total = frame.Length;
                        const int maxChunk = 7680;

                        while (offset < total)
                        {
                            int count = Math.Min(maxChunk, total - offset);
                            _stream.Write(frame, offset, count);
                            offset += count;
                        }
                        _stream.Flush();
                    }
                    catch
                    {
                        break;
                    }
                }
                else
                {
                    _sendSignal.WaitOne(100);
                }
            }
        }

        public void ProcessLoop()
        {
            try
            {
                while (_running)
                {
                    int b0 = _stream.ReadByte();
                    if (b0 == -1) break;

                    int b1 = _stream.ReadByte();
                    if (b1 == -1) break;

                    bool fin = (b0 & 0x80) != 0;
                    int opcode = b0 & 0x0F;
                    bool masked = (b1 & 0x80) != 0;
                    long payloadLength = b1 & 0x7F;

                    if (payloadLength == 126)
                    {
                        int len1 = _stream.ReadByte();
                        int len2 = _stream.ReadByte();
                        payloadLength = (len1 << 8) | len2;
                    }
                    else if (payloadLength == 127)
                    {
                        byte[] lenBytes = new byte[8];
                        _stream.Read(lenBytes, 0, 8);
                        Array.Reverse(lenBytes);
                        payloadLength = BitConverter.ToInt64(lenBytes, 0);
                    }

                    byte[] mask = new byte[4];
                    if (masked)
                    {
                        _stream.Read(mask, 0, 4);
                    }

                    byte[] payload = new byte[payloadLength];
                    int totalRead = 0;
                    while (totalRead < payloadLength)
                    {
                        int read = _stream.Read(payload, totalRead, (int)(payloadLength - totalRead));
                        if (read <= 0) break;
                        totalRead += read;
                    }

                    if (masked)
                    {
                        for (int i = 0; i < payload.Length; i++)
                        {
                            payload[i] ^= mask[i % 4];
                        }
                    }

                    if (opcode == 0x8) // Close
                    {
                        break;
                    }
                    else if (opcode == 0x9) // Ping
                    {
                        SendPong(payload);
                    }
                    else if (opcode == 0x1) // Text Frame
                    {
                        string message = Encoding.UTF8.GetString(payload);
                        _server.HandleWebSocketMessage(this, message);
                    }
                }
            }
            catch { }
            finally
            {
                _server.RemoveClient(this);
                Close();
            }
        }

        public void Send(string text)
        {
            if (!_running) return;
            try
            {
                byte[] payload = Encoding.UTF8.GetBytes(text);
                using (MemoryStream ms = new MemoryStream(payload.Length + 10))
                {
                    ms.WriteByte(0x81); // FIN + Text
                    if (payload.Length <= 125)
                    {
                        ms.WriteByte((byte)payload.Length);
                    }
                    else if (payload.Length <= 65535)
                    {
                        ms.WriteByte(126);
                        ms.WriteByte((byte)((payload.Length >> 8) & 0xFF));
                        ms.WriteByte((byte)(payload.Length & 0xFF));
                    }
                    else
                    {
                        ms.WriteByte(127);
                        for (int i = 7; i >= 0; i--)
                        {
                            ms.WriteByte((byte)((payload.Length >> (8 * i)) & 0xFF));
                        }
                    }
                    ms.Write(payload, 0, payload.Length);
                    byte[] frame = ms.ToArray();

                    lock (_sendLock)
                    {
                        _sendQueue.Enqueue(frame);
                    }
                    _sendSignal.Set();
                }
            }
            catch { }
        }

        private void SendPong(byte[] payload)
        {
            if (!_running) return;
            try
            {
                byte[] frame = new byte[2 + payload.Length];
                frame[0] = 0x8A;
                frame[1] = (byte)payload.Length;
                Array.Copy(payload, 0, frame, 2, payload.Length);
                lock (_sendLock)
                {
                    _sendQueue.Enqueue(frame);
                }
                _sendSignal.Set();
            }
            catch { }
        }

        public void Close()
        {
            _running = false;
            try { _sendSignal.Set(); } catch { }
            try { _tcp.Close(); } catch { }
        }
    }

    // =========================================================================
    // Modern Dark-Mode Windows Forms GUI Controller
    // =========================================================================
    public class WinVRForm : Form
    {
        private readonly WinVRServer _server;
        private readonly string _localIp;
        private readonly int _httpPort;
        private readonly int _httpsPort;

        private Label lblStatus;
        private Label lblStats;
        private TextBox txtHttpUrl;
        private TextBox txtHttpsUrl;
        private ListBox lstLog;
        private CheckBox chkMouseLook;
        private TrackBar tbYaw;
        private TrackBar tbPitch;
        private TrackBar tbSmoothing;
        private Label lblYawVal;
        private Label lblPitchVal;
        private Label lblSmoothVal;

        public WinVRForm(WinVRServer server, string localIp, int httpPort, int httpsPort)
        {
            _server = server;
            _localIp = localIp;
            _httpPort = httpPort;
            _httpsPort = httpsPort;

            InitUI();

            _server.OnLog += LogToUi;
            _server.OnStatsUpdated += (clients, rate) => {
                if (this.IsDisposed || !this.IsHandleCreated) return;
                this.BeginInvoke(new Action(() => {
                    lblStats.Text = string.Format("Clients: {0} | Gyro Rate: {1:F0} pkts/sec", clients, rate);
                }));
            };
        }

        private void InitUI()
        {
            this.Text = "⚡ WinVR - Windows Display to VR Converter";
            this.Size = new Size(720, 620);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(14, 18, 28);
            this.ForeColor = Color.FromArgb(230, 238, 248);
            this.Font = new Font("Segoe UI", 9F, FontStyle.Regular);
            this.FormBorderStyle = FormBorderStyle.FixedSingle;
            this.MaximizeBox = false;

            // Header Banner
            Panel pnlHeader = new Panel();
            pnlHeader.Dock = DockStyle.Top;
            pnlHeader.Height = 75;
            pnlHeader.BackColor = Color.FromArgb(20, 28, 44);
            pnlHeader.Padding = new Padding(16, 10, 16, 10);

            Label lblTitle = new Label();
            lblTitle.Text = "⚡ WinVR CONTROLLER";
            lblTitle.Font = new Font("Segoe UI", 14F, FontStyle.Bold);
            lblTitle.ForeColor = Color.FromArgb(0, 242, 254);
            lblTitle.AutoSize = true;
            lblTitle.Location = new Point(14, 10);
            pnlHeader.Controls.Add(lblTitle);

            lblStatus = new Label();
            lblStatus.Text = string.Format("Ports: HTTP {0} | HTTPS {1} | UDP 8082 (16MB Sockets)", _httpPort, _httpsPort);
            lblStatus.ForeColor = Color.FromArgb(140, 160, 190);
            lblStatus.AutoSize = true;
            lblStatus.Location = new Point(16, 42);
            pnlHeader.Controls.Add(lblStatus);

            lblStats = new Label();
            lblStats.Text = "Clients: 0 | Gyro Rate: 0 pkts/sec";
            lblStats.ForeColor = Color.FromArgb(0, 255, 170);
            lblStats.AutoSize = true;
            lblStats.Location = new Point(460, 42);
            pnlHeader.Controls.Add(lblStats);

            this.Controls.Add(pnlHeader);

            // Launch Dashboard Button
            Button btnLaunchHost = new Button();
            btnLaunchHost.Text = "🚀 Open PC Control Dashboard (Select Window to Cast)";
            btnLaunchHost.Location = new Point(20, 90);
            btnLaunchHost.Size = new Size(665, 42);
            btnLaunchHost.BackColor = Color.FromArgb(0, 114, 255);
            btnLaunchHost.ForeColor = Color.White;
            btnLaunchHost.FlatStyle = FlatStyle.Flat;
            btnLaunchHost.FlatAppearance.BorderSize = 0;
            btnLaunchHost.Font = new Font("Segoe UI", 10F, FontStyle.Bold);
            btnLaunchHost.Cursor = Cursors.Hand;
            btnLaunchHost.Click += (s, e) => {
                Process.Start(string.Format("http://localhost:{0}", _httpPort));
            };
            this.Controls.Add(btnLaunchHost);

            // Phone URL GroupBox (Dual HTTP + HTTPS)
            GroupBox grpPhone = new GroupBox();
            grpPhone.Text = "📱 Phone Connection URLs (Open in Mobile Browser on same Wi-Fi)";
            grpPhone.Location = new Point(20, 145);
            grpPhone.Size = new Size(665, 110);
            grpPhone.ForeColor = Color.FromArgb(0, 242, 254);

            // HTTPS Row (Recommended for Gyro)
            Label lblHttps = new Label();
            lblHttps.Text = "HTTPS (Unlocks Gyro):";
            lblHttps.Location = new Point(14, 28);
            lblHttps.Size = new Size(140, 20);
            lblHttps.ForeColor = Color.FromArgb(0, 255, 170);
            grpPhone.Controls.Add(lblHttps);

            string httpsUrl = string.Format("https://{0}:{1}/vr", _localIp, _httpsPort);
            txtHttpsUrl = new TextBox();
            txtHttpsUrl.Text = httpsUrl;
            txtHttpsUrl.ReadOnly = true;
            txtHttpsUrl.Location = new Point(160, 25);
            txtHttpsUrl.Size = new Size(380, 24);
            txtHttpsUrl.BackColor = Color.FromArgb(10, 14, 22);
            txtHttpsUrl.ForeColor = Color.FromArgb(0, 255, 170);
            txtHttpsUrl.Font = new Font("Consolas", 9.5F, FontStyle.Bold);
            grpPhone.Controls.Add(txtHttpsUrl);

            Button btnCopyHttps = new Button();
            btnCopyHttps.Text = "Copy HTTPS";
            btnCopyHttps.Location = new Point(550, 23);
            btnCopyHttps.Size = new Size(100, 26);
            btnCopyHttps.BackColor = Color.FromArgb(35, 45, 65);
            btnCopyHttps.ForeColor = Color.White;
            btnCopyHttps.FlatStyle = FlatStyle.Flat;
            btnCopyHttps.Click += (s, e) => {
                Clipboard.SetText(httpsUrl);
                MessageBox.Show("Copied HTTPS URL to clipboard!\n\nNote: In mobile browser, click 'Advanced -> Proceed' on first visit.", "WinVR", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };
            grpPhone.Controls.Add(btnCopyHttps);

            // HTTP Row
            Label lblHttp = new Label();
            lblHttp.Text = "HTTP Standard:";
            lblHttp.Location = new Point(14, 68);
            lblHttp.Size = new Size(140, 20);
            lblHttp.ForeColor = Color.FromArgb(180, 190, 210);
            grpPhone.Controls.Add(lblHttp);

            string httpUrl = string.Format("http://{0}:{1}/vr", _localIp, _httpPort);
            txtHttpUrl = new TextBox();
            txtHttpUrl.Text = httpUrl;
            txtHttpUrl.ReadOnly = true;
            txtHttpUrl.Location = new Point(160, 65);
            txtHttpUrl.Size = new Size(380, 24);
            txtHttpUrl.BackColor = Color.FromArgb(10, 14, 22);
            txtHttpUrl.ForeColor = Color.FromArgb(0, 242, 254);
            txtHttpUrl.Font = new Font("Consolas", 9.5F);
            grpPhone.Controls.Add(txtHttpUrl);

            Button btnCopyHttp = new Button();
            btnCopyHttp.Text = "Copy HTTP";
            btnCopyHttp.Location = new Point(550, 63);
            btnCopyHttp.Size = new Size(100, 26);
            btnCopyHttp.BackColor = Color.FromArgb(35, 45, 65);
            btnCopyHttp.ForeColor = Color.White;
            btnCopyHttp.FlatStyle = FlatStyle.Flat;
            btnCopyHttp.Click += (s, e) => {
                Clipboard.SetText(httpUrl);
            };
            grpPhone.Controls.Add(btnCopyHttp);

            this.Controls.Add(grpPhone);

            // Head Tracking Tuning Panel
            GroupBox grpTracking = new GroupBox();
            grpTracking.Text = "🎮 Gyroscope Head-Tracking & Mouse Settings";
            grpTracking.Location = new Point(20, 265);
            grpTracking.Size = new Size(665, 140);
            grpTracking.ForeColor = Color.FromArgb(0, 242, 254);

            chkMouseLook = new CheckBox();
            chkMouseLook.Text = "Enable Gyro Mouse Movement in Windows (For PC Games)";
            chkMouseLook.Checked = false;
            chkMouseLook.Location = new Point(16, 25);
            chkMouseLook.AutoSize = true;
            chkMouseLook.ForeColor = Color.White;
            chkMouseLook.CheckedChanged += (s, e) => {
                _server.Mouse.MouseLookEnabled = chkMouseLook.Checked;
            };
            grpTracking.Controls.Add(chkMouseLook);

            Button btnTestMouse = new Button();
            btnTestMouse.Text = "🧪 Test Mouse Move (+50px)";
            btnTestMouse.Location = new Point(480, 20);
            btnTestMouse.Size = new Size(170, 28);
            btnTestMouse.BackColor = Color.FromArgb(35, 55, 80);
            btnTestMouse.ForeColor = Color.FromArgb(0, 255, 170);
            btnTestMouse.FlatStyle = FlatStyle.Flat;
            btnTestMouse.Click += (s, e) => {
                Win32.InjectMouseMove(50, 0);
            };
            grpTracking.Controls.Add(btnTestMouse);

            // Yaw Slider
            Label lblYaw = new Label();
            lblYaw.Text = "Yaw Sens:";
            lblYaw.Location = new Point(16, 58);
            lblYaw.AutoSize = true;
            lblYaw.ForeColor = Color.FromArgb(180, 190, 210);
            grpTracking.Controls.Add(lblYaw);

            tbYaw = new TrackBar();
            tbYaw.Location = new Point(80, 53);
            tbYaw.Size = new Size(110, 30);
            tbYaw.Minimum = 2;
            tbYaw.Maximum = 60;
            tbYaw.Value = (int)(_server.Mouse.YawSensitivity * 10);
            tbYaw.Scroll += (s, e) => {
                _server.Mouse.YawSensitivity = tbYaw.Value / 10.0;
                lblYawVal.Text = string.Format("{0:F1}x", _server.Mouse.YawSensitivity);
            };
            grpTracking.Controls.Add(tbYaw);

            lblYawVal = new Label();
            lblYawVal.Text = string.Format("{0:F1}x", _server.Mouse.YawSensitivity);
            lblYawVal.Location = new Point(195, 58);
            lblYawVal.AutoSize = true;
            lblYawVal.ForeColor = Color.FromArgb(0, 242, 254);
            grpTracking.Controls.Add(lblYawVal);

            // Pitch Slider
            Label lblPitch = new Label();
            lblPitch.Text = "Pitch Sens:";
            lblPitch.Location = new Point(235, 58);
            lblPitch.AutoSize = true;
            lblPitch.ForeColor = Color.FromArgb(180, 190, 210);
            grpTracking.Controls.Add(lblPitch);

            tbPitch = new TrackBar();
            tbPitch.Location = new Point(305, 53);
            tbPitch.Size = new Size(110, 30);
            tbPitch.Minimum = 2;
            tbPitch.Maximum = 60;
            tbPitch.Value = (int)(_server.Mouse.PitchSensitivity * 10);
            tbPitch.Scroll += (s, e) => {
                _server.Mouse.PitchSensitivity = tbPitch.Value / 10.0;
                lblPitchVal.Text = string.Format("{0:F1}x", _server.Mouse.PitchSensitivity);
            };
            grpTracking.Controls.Add(tbPitch);

            lblPitchVal = new Label();
            lblPitchVal.Text = string.Format("{0:F1}x", _server.Mouse.PitchSensitivity);
            lblPitchVal.Location = new Point(420, 58);
            lblPitchVal.AutoSize = true;
            lblPitchVal.ForeColor = Color.FromArgb(0, 242, 254);
            grpTracking.Controls.Add(lblPitchVal);

            // Smoothing Slider
            Label lblSmooth = new Label();
            lblSmooth.Text = "Smooth:";
            lblSmooth.Location = new Point(460, 58);
            lblSmooth.AutoSize = true;
            lblSmooth.ForeColor = Color.FromArgb(180, 190, 210);
            grpTracking.Controls.Add(lblSmooth);

            tbSmoothing = new TrackBar();
            tbSmoothing.Location = new Point(515, 53);
            tbSmoothing.Size = new Size(100, 30);
            tbSmoothing.Minimum = 0;
            tbSmoothing.Maximum = 90;
            tbSmoothing.Value = (int)(_server.Mouse.Smoothing * 100);
            tbSmoothing.Scroll += (s, e) => {
                _server.Mouse.Smoothing = tbSmoothing.Value / 100.0;
                lblSmoothVal.Text = string.Format("{0}%", tbSmoothing.Value);
            };
            grpTracking.Controls.Add(tbSmoothing);

            lblSmoothVal = new Label();
            lblSmoothVal.Text = string.Format("{0}%", tbSmoothing.Value);
            lblSmoothVal.Location = new Point(620, 58);
            lblSmoothVal.AutoSize = true;
            lblSmoothVal.ForeColor = Color.FromArgb(0, 242, 254);
            grpTracking.Controls.Add(lblSmoothVal);

            Button btnRecenter = new Button();
            btnRecenter.Text = "🎯 Recenter Forward Heading";
            btnRecenter.Location = new Point(16, 95);
            btnRecenter.Size = new Size(200, 28);
            btnRecenter.BackColor = Color.FromArgb(35, 45, 65);
            btnRecenter.ForeColor = Color.White;
            btnRecenter.FlatStyle = FlatStyle.Flat;
            btnRecenter.Click += (s, e) => {
                _server.Mouse.Reset();
            };
            grpTracking.Controls.Add(btnRecenter);

            this.Controls.Add(grpTracking);

            // Activity Log
            Label lblLog = new Label();
            lblLog.Text = "Real-Time Activity Log:";
            lblLog.Location = new Point(20, 415);
            lblLog.AutoSize = true;
            lblLog.ForeColor = Color.FromArgb(140, 160, 190);
            this.Controls.Add(lblLog);

            lstLog = new ListBox();
            lstLog.Location = new Point(20, 435);
            lstLog.Size = new Size(665, 125);
            lstLog.BackColor = Color.FromArgb(10, 14, 22);
            lstLog.ForeColor = Color.FromArgb(0, 255, 170);
            lstLog.Font = new Font("Consolas", 8.5F);
            lstLog.BorderStyle = BorderStyle.FixedSingle;
            this.Controls.Add(lstLog);
        }

        private void LogToUi(string msg)
        {
            if (this.IsDisposed || !this.IsHandleCreated) return;
            this.BeginInvoke(new Action(() => {
                lstLog.Items.Add(msg);
                if (lstLog.Items.Count > 100) lstLog.Items.RemoveAt(0);
                lstLog.TopIndex = lstLog.Items.Count - 1;
            }));
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _server.Stop();
            base.OnFormClosing(e);
        }
    }

    // =========================================================================
    // Application Entry Point
    // =========================================================================
    class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            int httpPort = 8080;
            int httpsPort = 8443;
            string localIp = WinVRServer.DiscoverLocalIP();

            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string webRoot = Path.Combine(exeDir, "web");
            if (!Directory.Exists(webRoot))
            {
                string parentWeb = Path.Combine(Directory.GetParent(exeDir).FullName, "web");
                if (Directory.Exists(parentWeb)) webRoot = parentWeb;
                else
                {
                    string curWeb = Path.Combine(Environment.CurrentDirectory, "web");
                    if (Directory.Exists(curWeb)) webRoot = curWeb;
                    else webRoot = ""; // Will serve seamlessly from embedded assembly resources!
                }
            }

            // Load SSL certificate from disk, or fall back to embedded certificate
            X509Certificate2 cert = null;
            string pfxPath = Path.Combine(exeDir, "cert.pfx");
            if (!File.Exists(pfxPath))
            {
                pfxPath = Path.Combine(Directory.GetParent(exeDir).FullName, "cert.pfx");
            }

            if (File.Exists(pfxPath))
            {
                try
                {
                    cert = new X509Certificate2(pfxPath, "winvr123");
                }
                catch (Exception ex)
                {
                    Console.WriteLine("Warning: Could not load cert.pfx from disk: " + ex.Message);
                }
            }
            if (cert == null)
            {
                try
                {
                    using (Stream s = typeof(Program).Assembly.GetManifestResourceStream("cert.pfx"))
                    {
                        if (s != null)
                        {
                            byte[] certBytes = new byte[s.Length];
                            s.Read(certBytes, 0, certBytes.Length);
                            cert = new X509Certificate2(certBytes, "winvr123");
                        }
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine("Warning: Could not load embedded cert: " + ex.Message);
                }
            }

            WinVRServer server = new WinVRServer(httpPort, httpsPort, webRoot, cert);
            server.Start();

            Console.WriteLine("========================================================");
            Console.WriteLine("    ⚡ WinVR - Windows Display to VR Converter Server    ");
            Console.WriteLine("========================================================");
            Console.WriteLine("Local IPv4: " + localIp);
            Console.WriteLine("HTTP:       http://" + localIp + ":" + server.HttpPort + "/vr");
            if (cert != null)
            {
                Console.WriteLine("HTTPS:      https://" + localIp + ":" + httpsPort + "/vr (Gyro Unlocked)");
            }
            Console.WriteLine("UDP:        " + localIp + ":8082 (16MB Sockets, Sub-ms Head Tracking)");
            Console.WriteLine("========================================================");

            bool isHeadless = false;
            foreach (string arg in args)
            {
                if (arg == "--headless" || arg == "--console")
                {
                    isHeadless = true;
                    break;
                }
            }

            if (isHeadless)
            {
                Console.WriteLine("Running in headless console mode. Press CTRL+C to exit.");
                while (true) Thread.Sleep(1000);
            }
            else
            {
                // Auto-launch the Dashboard in the user's default browser on startup
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    Thread.Sleep(600);
                    try
                    {
                        Process.Start(string.Format("http://localhost:{0}/", server.HttpPort));
                    }
                    catch { }
                });

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new WinVRForm(server, localIp, server.HttpPort, httpsPort));
            }
        }
    }
}
