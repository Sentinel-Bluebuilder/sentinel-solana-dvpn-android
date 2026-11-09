// pipe-bridge relays a private per-user named pipe to the dvpnd control pipe.
//
// Why it exists: dvpnd's socket_group ACE grants the group exactly 0x120183
// (read/write data + attributes, READ_CONTROL, SYNCHRONIZE). Node's libuv (and
// go-winio's DialPipe) open pipes with GENERIC_READ|GENERIC_WRITE, which maps to
// FILE_GENERIC_WRITE and also asks for FILE_APPEND_DATA (create-instance) and
// FILE_WRITE_EA — not granted — so an unelevated Electron app gets
// ERROR_ACCESS_DENIED. This bridge runs as the same user, opens the daemon pipe
// with exactly the granted rights, and serves a pipe only this user can open.
//
// Contract with the app:
//   - prints "ready <pipe path>" on stdout once listening;
//   - exits when stdin closes (the app owns its lifetime);
//   - the listen path carries a random suffix and is created first-instance,
//     so another process cannot squat it.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const daemonClientRights = 0x120183 // must not exceed the ACE dvpnd grants socket_group

func main() {
	daemon := flag.String("daemon", `\\.\pipe\ProtectedPrefix\Administrators\dvpnd\client`, "dvpnd control pipe")
	flag.Parse()

	sid, err := currentUserSID()
	if err != nil {
		fail("reading current user SID: %v", err)
	}

	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		fail("random suffix: %v", err)
	}
	listen := fmt.Sprintf(`\\.\pipe\devnet-dvpn-%s-%s`, sid, hex.EncodeToString(suffix))

	// Only this user and SYSTEM; protected DACL (no inheritance).
	sddl := fmt.Sprintf("D:P(A;;GA;;;%s)(A;;GA;;;SY)", sid)
	ln, err := winio.ListenPipe(listen, &winio.PipeConfig{SecurityDescriptor: sddl})
	if err != nil {
		fail("listening on %s: %v", listen, err)
	}

	// Check once that the daemon pipe is reachable with the narrow rights.
	if probe, err := dial(*daemon); err != nil {
		fail("daemon pipe %s: %v", *daemon, err)
	} else {
		_ = probe.Close()
	}

	fmt.Printf("ready %s\n", listen)

	var closing atomic.Bool
	go func() {
		// The app holds our stdin; when it goes away, so do we.
		_, _ = io.Copy(io.Discard, bufio.NewReader(os.Stdin))
		closing.Store(true)
		_ = ln.Close()
		os.Exit(0)
	}()

	for {
		c, err := ln.Accept()
		if err != nil {
			if closing.Load() {
				os.Exit(0)
			}
			fail("accept: %v", err)
		}
		go relay(c, *daemon)
	}
}

func dial(path string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return winio.DialPipeAccess(ctx, path, daemonClientRights)
}

func relay(c net.Conn, daemon string) {
	defer c.Close()
	d, err := dial(daemon)
	if err != nil {
		fmt.Fprintf(os.Stderr, "dial daemon: %v\n", err)
		return
	}
	defer d.Close()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _, _ = io.Copy(d, c); halfClose(d) }()
	go func() { defer wg.Done(); _, _ = io.Copy(c, d); halfClose(c) }()
	wg.Wait()
}

// halfClose tells the other end we are done writing. A byte-mode pipe from
// DialPipeAccess has no CloseWrite (only message-mode pipes do), so close it
// fully instead; that also ends the copy in the other direction. A plain type
// assertion here panicked and took every open daemon call down with it.
func halfClose(c net.Conn) {
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		if err := cw.CloseWrite(); err == nil {
			return
		}
	}
	_ = c.Close()
}

func currentUserSID() (string, error) {
	tok := windows.GetCurrentProcessToken()
	u, err := tok.GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String(), nil
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
