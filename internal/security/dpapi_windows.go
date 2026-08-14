//go:build windows

package security

import (
	"fmt"
	"syscall"
	"unsafe"
)

type dataBlob struct {
	cbData uint32
	pbData *byte
}

var (
	crypt32   = syscall.NewLazyDLL("crypt32.dll")
	kernel32  = syscall.NewLazyDLL("kernel32.dll")
	protect   = crypt32.NewProc("CryptProtectData")
	unprotect = crypt32.NewProc("CryptUnprotectData")
	localFree = kernel32.NewProc("LocalFree")
)

func dpapiTransform(input []byte, decrypt bool) ([]byte, error) {
	if len(input) == 0 {
		return []byte{}, nil
	}
	inputCopy := append([]byte(nil), input...)
	in := dataBlob{cbData: uint32(len(inputCopy)), pbData: &inputCopy[0]}
	var out dataBlob
	var result uintptr
	if decrypt {
		result, _, _ = unprotect.Call(
			uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 0,
			uintptr(unsafe.Pointer(&out)),
		)
	} else {
		result, _, _ = protect.Call(
			uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 0,
			uintptr(unsafe.Pointer(&out)),
		)
	}
	if result == 0 || out.pbData == nil || out.cbData == 0 {
		return nil, fmt.Errorf("Windows DPAPI transform failed: %w", syscall.GetLastError())
	}
	defer localFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return append([]byte(nil), unsafe.Slice(out.pbData, out.cbData)...), nil
}

func Protect(data []byte) ([]byte, error)   { return dpapiTransform(data, false) }
func Unprotect(data []byte) ([]byte, error) { return dpapiTransform(data, true) }
