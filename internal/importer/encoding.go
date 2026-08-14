package importer

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"

	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/transform"
)

type Encoding string

const (
	EncodingAuto  Encoding = "auto"
	EncodingUTF8  Encoding = "utf-8"
	EncodingCP932 Encoding = "cp932"
)

func DecodeReader(reader io.Reader, requested Encoding) (io.Reader, Encoding, error) {
	data, err := io.ReadAll(reader)
	if err != nil {
		return nil, "", err
	}
	encoding := requested
	if len(data) >= 3 && bytes.Equal(data[:3], []byte{0xef, 0xbb, 0xbf}) {
		data = data[3:]
		encoding = EncodingUTF8
	}
	if encoding == EncodingAuto {
		if utf8Valid(data) {
			encoding = EncodingUTF8
		} else {
			encoding = EncodingCP932
		}
	}
	if encoding == EncodingUTF8 {
		if !utf8Valid(data) {
			return nil, "", fmt.Errorf("invalid UTF-8 CSV")
		}
		return bytes.NewReader(data), encoding, nil
	}
	decoded, _, err := transform.String(japanese.ShiftJIS.NewDecoder(), string(data))
	if err != nil {
		return nil, "", fmt.Errorf("decode CP932 CSV: %w", err)
	}
	return bytes.NewReader([]byte(decoded)), EncodingCP932, nil
}

func ReadDecodedFile(path string, requested Encoding) ([]byte, Encoding, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	reader, encoding, err := DecodeReader(bufio.NewReader(file), requested)
	if err != nil {
		return nil, "", err
	}
	data, err := io.ReadAll(reader)
	return data, encoding, err
}

func utf8Valid(data []byte) bool {
	for len(data) > 0 {
		runeSize := 1
		if data[0] >= 0xC2 && data[0] <= 0xDF {
			runeSize = 2
		} else if data[0] >= 0xE0 && data[0] <= 0xEF {
			runeSize = 3
		} else if data[0] >= 0xF0 && data[0] <= 0xF4 {
			runeSize = 4
		} else if data[0] < 0x80 {
			data = data[1:]
			continue
		} else {
			return false
		}
		if len(data) < runeSize {
			return false
		}
		for _, value := range data[1:runeSize] {
			if value&0xC0 != 0x80 {
				return false
			}
		}
		data = data[runeSize:]
	}
	return true
}
