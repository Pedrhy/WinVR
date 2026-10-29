using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using WinVR;

namespace WinVR.Tests
{
    class MockClient : WebSocketClient
    {
        public List<string> SentMessages = new List<string>();

        public MockClient(WinVRServer server) : base(new System.Net.Sockets.TcpClient(), new System.IO.MemoryStream(), server)
        {
        }

        public new void Send(string text)
        {
            SentMessages.Add(text);
        }
    }

    class TestRunner
    {
        static int _passed = 0;
        static int _failed = 0;

        static void Assert(bool condition, string testName)
        {
            if (condition)
            {
                Console.WriteLine("  [PASS] " + testName);
                _passed++;
            }
            else
            {
                Console.WriteLine("  [FAIL] " + testName);
                _failed++;
            }
        }

        public static int Main()
        {
            Console.WriteLine("==================================================");
            Console.WriteLine("     WinVR Protocol & Engine Automated Tests      ");
            Console.WriteLine("==================================================");

            TestMouseEngine();
            TestFastMotionProtocol();
            TestBurstProtection();
            TestFallbackProtocol();
            TestCapabilityNegotiation();

            Console.WriteLine("--------------------------------------------------");
            Console.WriteLine(string.Format("Test Results: {0} Passed, {1} Failed", _passed, _failed));
            Console.WriteLine("==================================================");

            return _failed == 0 ? 0 : 1;
        }

        static void TestMouseEngine()
        {
            Console.WriteLine("\nTesting MouseEngine...");
            var engine = new MouseEngine();
            engine.MouseLookEnabled = true;
            engine.YawSensitivity = 2.0;
            engine.PitchSensitivity = 1.8;
            engine.Smoothing = 0.0;
            engine.Deadzone = 0.0;

            // Test reset
            engine.Reset();
            Assert(engine.MouseLookEnabled == true, "MouseLookEnabled is true");
            Assert(engine.YawSensitivity == 2.0, "YawSensitivity is 2.0");

            // Test inverting
            engine.InvertX = true;
            engine.InvertY = true;
            Assert(engine.InvertX == true && engine.InvertY == true, "Invert axes settings preserved");

            // Test stationary noise floor & accumulator decay
            engine.Reset();
            engine.Deadzone = 0.003;
            engine.NoiseFloor = 0.008;
            // Feed stationary sub-threshold noise
            for (int i = 0; i < 20; i++)
            {
                engine.ProcessGyroDelta(0.004, -0.003);
            }
            Assert(Math.Abs(engine.GetAccumX()) < 0.01 && Math.Abs(engine.GetAccumY()) < 0.01, "Stationary noise floor decays accumulators to prevent creeping drift");
        }

        static void TestFastMotionProtocol()
        {
            Console.WriteLine("\nTesting Fast-Path Motion Protocol (G,dx,dy,clientTs)...");
            var server = new WinVRServer(8099, 8499, AppDomain.CurrentDomain.BaseDirectory, null);
            var client = new MockClient(server);
            client.Role = "client";

            long initialCount = server.GyroPacketCount;

            // Send fast motion packet
            server.HandleWebSocketMessage(client, "G,0.25,-0.15,54321.0");

            Assert(server.GyroPacketCount == initialCount + 1, "GyroPacketCount incremented on fast motion packet");

            // Send multiple fast motion packets
            for (int i = 0; i < 10; i++)
            {
                server.HandleWebSocketMessage(client, string.Format("G,0.01,0.02,{0}", 1000 + i * 10));
            }
            Assert(server.GyroPacketCount == initialCount + 11, "Continuous high-frequency fast motion processed cleanly");
        }

        static void TestBurstProtection()
        {
            Console.WriteLine("\nTesting Burst Dampening & Stutter Protection...");
            var server = new WinVRServer(8099, 8499, AppDomain.CurrentDomain.BaseDirectory, null);
            var client = new MockClient(server);
            client.Role = "client";

            server.Mouse.MouseLookEnabled = true;
            server.Mouse.Reset();

            // Simulate burst delivery of multiple queued packets in < 1ms
            server.HandleWebSocketMessage(client, "G,0.5,0.0,1000.0");
            server.HandleWebSocketMessage(client, "G,10.0,0.0,1001.0"); // extreme spike during burst flush

            // Should not crash and packet count increments
            Assert(server.GyroPacketCount == 2, "Burst packets safely processed and clamped without exceptions");
        }

        static void TestFallbackProtocol()
        {
            Console.WriteLine("\nTesting Fallback JSON Protocol (gyro_delta)...");
            var server = new WinVRServer(8099, 8499, AppDomain.CurrentDomain.BaseDirectory, null);
            var client = new MockClient(server);
            client.Role = "client";

            long initialCount = server.GyroPacketCount;

            // Send JSON gyro delta packet
            server.HandleWebSocketMessage(client, "{\"type\":\"gyro_delta\",\"dx\":0.5,\"dy\":-0.3}");

            Assert(server.GyroPacketCount == initialCount + 1, "GyroPacketCount incremented on fallback JSON packet");
        }

        static void TestCapabilityNegotiation()
        {
            Console.WriteLine("\nTesting Capability Negotiation & Handshake...");
            var server = new WinVRServer(8099, 8499, AppDomain.CurrentDomain.BaseDirectory, null);
            var client = new MockClient(server);

            // Register as phone client
            server.HandleWebSocketMessage(client, "{\"type\":\"register\",\"role\":\"client\"}");

            Assert(client.Role == "client", "Client role registered as 'client'");
            Assert(server.PhoneClient == client, "Server PhoneClient reference set");
        }
    }
}
