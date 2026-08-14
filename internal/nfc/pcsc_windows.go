//go:build windows

package nfc

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	scardSuccess      uint32 = 0
	scardScopeUser    uint32 = 0
	scardShareShared  uint32 = 2
	scardProtocolT0   uint32 = 1
	scardProtocolT1   uint32 = 2
	scardLeaveCard    uint32 = 0
	scardStateUna     uint32 = 0
	scardStateChanged uint32 = 2
	scardStatePresent uint32 = 0x20
)

var winSCard = syscall.NewLazyDLL("winscard.dll")
var (
	sCardEstablishContext = winSCard.NewProc("SCardEstablishContext")
	sCardReleaseContext   = winSCard.NewProc("SCardReleaseContext")
	sCardListReaders      = winSCard.NewProc("SCardListReadersW")
	sCardGetStatusChange  = winSCard.NewProc("SCardGetStatusChangeW")
	sCardConnect          = winSCard.NewProc("SCardConnectW")
	sCardDisconnect       = winSCard.NewProc("SCardDisconnect")
	sCardTransmit         = winSCard.NewProc("SCardTransmit")
)

type cardReaderState struct {
	reader       *uint16
	currentState uint32
	eventState   uint32
	atrLength    uint32
	atr          [36]byte
}

type cardIORequest struct {
	protocol uint32
	length   uint32
}

type PCSCReader struct{}

func (PCSCReader) Run(ctx context.Context, emit func(string)) error {
	var contextHandle uintptr
	result, _, _ := sCardEstablishContext.Call(uintptr(scardScopeUser), 0, 0, uintptr(unsafe.Pointer(&contextHandle)))
	if uint32(result) != scardSuccess {
		return fmt.Errorf("establish PC/SC context: 0x%x", uint32(result))
	}
	defer sCardReleaseContext.Call(contextHandle)
	backoff := 500 * time.Millisecond
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		readers, err := listReaders(contextHandle)
		if err != nil {
			if err := waitContext(ctx, backoff); err != nil {
				return nil
			}
			if backoff < 5*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = 500 * time.Millisecond
		for _, readerName := range readers {
			if err := ctx.Err(); err != nil {
				return nil
			}
			reader, err := syscall.UTF16PtrFromString(readerName)
			if err != nil {
				continue
			}
			state := cardReaderState{reader: reader, currentState: scardStateUna}
			result, _, _ := sCardGetStatusChange.Call(contextHandle, 2000, uintptr(unsafe.Pointer(&state)), 1)
			if uint32(result) != scardSuccess || state.eventState&scardStatePresent == 0 {
				continue
			}
			if state.eventState&scardStateChanged == 0 {
				continue
			}
			uid, err := readUID(contextHandle, reader)
			if err == nil && uid != "" && emit != nil {
				emit(uid)
			}
		}
		if err := waitContext(ctx, 150*time.Millisecond); err != nil {
			return nil
		}
	}
}

func listReaders(contextHandle uintptr) ([]string, error) {
	var count uint32
	result, _, _ := sCardListReaders.Call(contextHandle, 0, 0, uintptr(unsafe.Pointer(&count)))
	if uint32(result) != scardSuccess || count == 0 {
		return nil, fmt.Errorf("no PC/SC readers available")
	}
	buffer := make([]uint16, count)
	result, _, _ = sCardListReaders.Call(contextHandle, 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&count)))
	if uint32(result) != scardSuccess {
		return nil, fmt.Errorf("list PC/SC readers: 0x%x", uint32(result))
	}
	var readers []string
	start := 0
	for index, value := range buffer {
		if value != 0 {
			continue
		}
		if index == start {
			break
		}
		readers = append(readers, syscall.UTF16ToString(buffer[start:index]))
		start = index + 1
	}
	return readers, nil
}

func readUID(contextHandle uintptr, reader *uint16) (string, error) {
	var card uintptr
	var protocol uint32
	result, _, _ := sCardConnect.Call(contextHandle, uintptr(unsafe.Pointer(reader)), uintptr(scardShareShared), uintptr(scardProtocolT0|scardProtocolT1), uintptr(unsafe.Pointer(&card)), uintptr(unsafe.Pointer(&protocol)))
	if uint32(result) != scardSuccess {
		return "", fmt.Errorf("connect smart card: 0x%x", uint32(result))
	}
	defer sCardDisconnect.Call(card, uintptr(scardLeaveCard))
	command := []byte{0xff, 0xca, 0x00, 0x00, 0x00}
	request := cardIORequest{protocol: protocol, length: uint32(unsafe.Sizeof(cardIORequest{}))}
	response := make([]byte, 258)
	responseLength := uint32(len(response))
	result, _, _ = sCardTransmit.Call(card, uintptr(unsafe.Pointer(&request)), uintptr(unsafe.Pointer(&command[0])), uintptr(len(command)), 0, uintptr(unsafe.Pointer(&response[0])), uintptr(unsafe.Pointer(&responseLength)))
	if uint32(result) != scardSuccess {
		return "", fmt.Errorf("read smart card UID: 0x%x", uint32(result))
	}
	if responseLength < 3 || response[responseLength-2] != 0x90 || response[responseLength-1] != 0x00 {
		return "", fmt.Errorf("smart card returned an invalid UID response")
	}
	return strings.ToUpper(hex.EncodeToString(response[:responseLength-2])), nil
}

func waitContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (PCSCReader) String() string { return "PC/SC" }
