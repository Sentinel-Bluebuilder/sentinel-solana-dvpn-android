// ddvprobe is a test oracle pushed to the emulator (/data/local/tmp) and run from `adb shell`.
// The shell user is inside the VPN (only our app is excluded), so what it sees is what any app
// on the phone sees. Built with cgo (NDK) so name lookups go through Android's resolver.
//
//	ddvprobe ip                    exit IPv4 as websites see it
//	ddvprobe ip6                   exit IPv6 (or "none")
//	ddvprobe get <url>             download, print "<bytes> <seconds> <mbps>"; each "{seed}" in the URL
//	                               becomes fresh random hex; DDVPROBE_PIN=sha256//<b64> pins a self-signed key
//	ddvprobe dns <name>            resolve with the system resolver, print addresses
//	ddvprobe tcp <host:port>       connect, print "ok <ms>" or the error
//	ddvprobe banner <host:port>    connect and read the first line the server sends (an SSH greeting),
//	                               print "banner <line>": proves the host was reached (a tun-to-proxy
//	                               engine accepts every TCP connect locally, so "tcp" alone cannot)
//	ddvprobe unix <@name> <line>   send one line to a local socket, print "reply <line>" or "closed"
//	                               (checks that the app's private sockets refuse other apps)
//
// Build (on the rig): CGO_ENABLED=1 GOOS=android GOARCH=amd64 CC=<ndk>/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android29-clang go build -o ddvprobe .
//
// Exit code 0 on success, 1 on failure.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const timeout = 30 * time.Second

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: ddvprobe ip [url]|ip6 [url]|get <url>|dns <name>|tcp <host:port>")
		os.Exit(2)
	}

	var err error

	switch os.Args[1] {
	// An optional URL picks the IP service: the cb33-matrix leak check needs one the app itself never asks,
	// so its DNS question can only be the test's (the app's own lookups go direct by design).
	case "ip":
		err = exitIP("tcp4", optArg(2, "https://api.ipify.org"))
	case "ip6":
		err = exitIP("tcp6", optArg(2, "https://api6.ipify.org"))
	case "get":
		err = get(arg(2))
	case "dns":
		err = resolve(arg(2))
	case "tcp":
		err = dial(arg(2))
	case "banner":
		err = banner(arg(2))
	case "unix":
		err = unixLine(arg(2), arg(3))
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}

	if err != nil {
		fmt.Println("error:", err)
		os.Exit(1)
	}
}

func optArg(i int, def string) string {
	if len(os.Args) <= i {
		return def
	}

	return os.Args[i]
}

func arg(i int) string {
	if len(os.Args) <= i {
		fmt.Fprintln(os.Stderr, "missing argument")
		os.Exit(2)
	}

	return os.Args[i]
}

func client(network string) *http.Client {
	d := &net.Dialer{Timeout: timeout}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			return d.DialContext(ctx, network, addr)
		},
		TLSHandshakeTimeout: timeout,
	}
	// DDVPROBE_PIN=sha256//<base64 SPKI digest> (curl's --pinnedpubkey form): a self-signed test origin is
	// accepted only when its public key matches the pin, so the server is still verified, by key instead of CA.
	if pin := os.Getenv("DDVPROBE_PIN"); pin != "" {
		want := strings.TrimPrefix(pin, "sha256//")
		tr.TLSClientConfig = &tls.Config{
			InsecureSkipVerify: true, // replaced by the pin check below
			VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
				if len(raw) == 0 {
					return fmt.Errorf("pin: no certificate")
				}
				c, err := x509.ParseCertificate(raw[0])
				if err != nil {
					return fmt.Errorf("pin: %w", err)
				}
				sum := sha256.Sum256(c.RawSubjectPublicKeyInfo)
				if got := base64.StdEncoding.EncodeToString(sum[:]); got != want {
					return fmt.Errorf("pin mismatch: server key sha256//%s", got)
				}
				return nil
			},
		}
	}

	return &http.Client{Transport: tr, Timeout: 3 * timeout}
}

// freshSeed replaces each "{seed}" in url with 16 new random hex characters, so a test origin that
// derives its bytes from the seed never serves a cacheable repeat.
func freshSeed(url string) (string, error) {
	for strings.Contains(url, "{seed}") {
		b := make([]byte, 8)
		if _, err := rand.Read(b); err != nil {
			return "", fmt.Errorf("seed: %w", err)
		}
		url = strings.Replace(url, "{seed}", hex.EncodeToString(b), 1)
	}
	return url, nil
}

func exitIP(network, url string) error {
	resp, err := client(network).Get(url)
	if err != nil {
		if network == "tcp6" {
			fmt.Println("none")

			return nil
		}

		return err
	}
	defer resp.Body.Close()

	b, err := io.ReadAll(io.LimitReader(resp.Body, 128))
	if err != nil {
		return err
	}

	fmt.Println(strings.TrimSpace(string(b)))

	return nil
}

func get(url string) error {
	url, err := freshSeed(url)
	if err != nil {
		return err
	}
	start := time.Now()

	resp, err := client("tcp").Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http %d", resp.StatusCode)
	}

	n, err := io.Copy(io.Discard, resp.Body)
	if err != nil {
		return fmt.Errorf("after %d bytes: %w", n, err)
	}

	secs := time.Since(start).Seconds()
	fmt.Printf("%d %.2f %.1f\n", n, secs, float64(n)*8/secs/1e6)

	return nil
}

func resolve(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	addrs, err := net.DefaultResolver.LookupHost(ctx, name)
	if err != nil {
		return err
	}

	fmt.Println(strings.Join(addrs, " "))

	return nil
}

func dial(addr string) error {
	start := time.Now()

	c, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return err
	}

	_ = c.Close()
	fmt.Printf("ok %d\n", time.Since(start).Milliseconds())

	return nil
}

func banner(addr string) error {
	c, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return err
	}
	defer c.Close()

	if err := c.SetReadDeadline(time.Now().Add(8 * time.Second)); err != nil {
		return err
	}

	line, err := bufio.NewReader(c).ReadString('\n')
	if line == "" {
		return fmt.Errorf("no greeting: %w", err)
	}

	fmt.Printf("banner %s\n", strings.TrimSpace(line))

	return nil
}

func unixLine(name, line string) error {
	c, err := net.DialTimeout("unix", name, timeout)
	if err != nil {
		return err
	}
	defer c.Close()

	_ = c.SetDeadline(time.Now().Add(3 * time.Second))

	if _, err := c.Write([]byte(line + "\n")); err != nil {
		fmt.Println("closed (write: " + err.Error() + ")")

		return nil
	}

	b, err := io.ReadAll(io.LimitReader(c, 4096))
	if len(b) == 0 {
		if err != nil {
			fmt.Println("closed (" + err.Error() + ")")
		} else {
			fmt.Println("closed")
		}

		return nil
	}

	fmt.Println("reply " + strings.TrimSpace(string(b)))

	return nil
}
