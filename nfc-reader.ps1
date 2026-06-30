Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NfcReader {
    [DllImport("winscard.dll")] static extern int SCardEstablishContext(uint s, IntPtr a, IntPtr b, ref IntPtr ctx);
    [DllImport("winscard.dll", EntryPoint="SCardListReadersW", CharSet=CharSet.Unicode)]
    static extern int SCardListReadersW(IntPtr ctx, IntPtr grp, IntPtr buf, ref uint cch);
    [DllImport("winscard.dll", EntryPoint="SCardGetStatusChangeW", CharSet=CharSet.Unicode)]
    static extern int SCardGetStatusChangeW(IntPtr ctx, uint timeout, IntPtr states, uint n);
    [DllImport("winscard.dll", EntryPoint="SCardConnectW", CharSet=CharSet.Unicode)]
    static extern int SCardConnectW(IntPtr ctx, string reader, uint share, uint proto, ref IntPtr card, ref uint activeProto);
    [DllImport("winscard.dll")] static extern int SCardDisconnect(IntPtr card, uint disp);
    [DllImport("winscard.dll")] static extern int SCardTransmit(IntPtr card, IntPtr sendPci, byte[] send, uint sendLen, IntPtr recvPci, byte[] recv, ref uint recvLen);

    const int STATE_SIZE     = 64;
    const int OFF_SZREADER   = 0;
    const int OFF_CURSTATE   = 16;
    const int OFF_EVTSTATE   = 20;
    const uint PRESENT       = 0x0020;
    const uint CHANGED       = 0x0002;
    const uint TIMEOUT_CODE  = 0x8010000A;

    static string[] ListReaders(IntPtr ctx) {
        uint cch = 0;
        if (SCardListReadersW(ctx, IntPtr.Zero, IntPtr.Zero, ref cch) != 0) return new string[0];
        IntPtr buf = Marshal.AllocHGlobal((int)cch * 2);
        try {
            if (SCardListReadersW(ctx, IntPtr.Zero, buf, ref cch) != 0) return new string[0];
            var list = new List<string>();
            int off = 0;
            while (off < (int)cch) {
                string s = Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + off * 2));
                if (string.IsNullOrEmpty(s)) break;
                list.Add(s);
                off += s.Length + 1;
            }
            return list.ToArray();
        } finally { Marshal.FreeHGlobal(buf); }
    }

    public static void Run() {
        IntPtr ctx = IntPtr.Zero;
        if (SCardEstablishContext(2, IntPtr.Zero, IntPtr.Zero, ref ctx) != 0) return;

        string[] readers = ListReaders(ctx);
        if (readers.Length == 0) return;
        string reader = readers[0];

        IntPtr statePtr = Marshal.AllocHGlobal(STATE_SIZE);
        IntPtr readerPtr = Marshal.StringToHGlobalUni(reader);
        try {
            for (int i = 0; i < STATE_SIZE; i++) Marshal.WriteByte(statePtr, i, 0);
            Marshal.WriteIntPtr(statePtr, OFF_SZREADER, readerPtr);
            Marshal.WriteInt32(statePtr, OFF_CURSTATE, 0);
            SCardGetStatusChangeW(ctx, 0, statePtr, 1);
            uint cur = (uint)Marshal.ReadInt32(statePtr, OFF_EVTSTATE) & ~CHANGED;

            while (true) {
                Marshal.WriteInt32(statePtr, OFF_CURSTATE, (int)(cur & 0xFFFF));
                int ret = SCardGetStatusChangeW(ctx, 5000, statePtr, 1);
                if (ret != 0) {
                    if ((uint)ret == TIMEOUT_CODE) continue;
                    System.Threading.Thread.Sleep(1000);
                    continue;
                }
                uint evt = (uint)Marshal.ReadInt32(statePtr, OFF_EVTSTATE);
                cur = evt & ~CHANGED;
                if ((evt & PRESENT) == 0) continue;

                IntPtr card = IntPtr.Zero;
                uint proto = 0;
                if (SCardConnectW(ctx, reader, 2, 3, ref card, ref proto) != 0) continue;
                try {
                    byte[] apdu = { 0xFF, 0xCA, 0x00, 0x00, 0x00 };
                    byte[] resp = new byte[256];
                    uint respLen = 256;
                    IntPtr pci = Marshal.AllocHGlobal(8);
                    Marshal.WriteInt32(pci, 0, (int)proto);
                    Marshal.WriteInt32(pci, 4, 8);
                    int r = SCardTransmit(card, pci, apdu, (uint)apdu.Length, IntPtr.Zero, resp, ref respLen);
                    Marshal.FreeHGlobal(pci);
                    if (r == 0 && respLen > 2) {
                        var sb = new StringBuilder();
                        for (int i = 0; i < (int)respLen - 2; i++) sb.AppendFormat("{0:X2}", resp[i]);
                        Console.WriteLine("UID:" + sb.ToString());
                        Console.Out.Flush();
                    }
                } finally {
                    SCardDisconnect(card, 1);
                }
                System.Threading.Thread.Sleep(1500);
            }
        } finally {
            Marshal.FreeHGlobal(readerPtr);
            Marshal.FreeHGlobal(statePtr);
        }
    }
}
"@

[NfcReader]::Run()
