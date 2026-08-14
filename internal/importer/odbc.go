package importer

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/transform"
)

type ODBCConfig struct {
	ConnectionString string
	Query            string
	MaxRows          int
	Encoding         string
}
type ODBCRecord map[string]any

type ODBCProvider interface {
	TestConnection(context.Context, ODBCConfig) error
	Tables(context.Context, ODBCConfig) ([]map[string]string, error)
	Query(context.Context, ODBCConfig) ([]ODBCRecord, error)
}

type UnsupportedODBC struct{}

func (UnsupportedODBC) TestConnection(context.Context, ODBCConfig) error {
	return fmt.Errorf("ODBC adapter is not available in this build")
}
func (UnsupportedODBC) Tables(context.Context, ODBCConfig) ([]map[string]string, error) {
	return nil, fmt.Errorf("ODBC adapter is not available in this build")
}
func (UnsupportedODBC) Query(context.Context, ODBCConfig) ([]ODBCRecord, error) {
	return nil, fmt.Errorf("ODBC adapter is not available in this build")
}

func validateReadQuery(query string) error {
	trimmed := strings.TrimSpace(strings.TrimSuffix(query, ";"))
	if trimmed == "" {
		return fmt.Errorf("ODBC query is required")
	}
	if hasTopLevelStatementSeparator(trimmed) {
		return fmt.Errorf("ODBC query must contain exactly one statement")
	}
	if keyword := firstSQLKeyword(trimmed); keyword != "SELECT" {
		return fmt.Errorf("ODBC sync accepts read-only SELECT or WITH queries")
	}
	return nil
}

// firstSQLKeyword returns the first statement keyword outside quoted text and
// parentheses. This permits a read-only CTE while rejecting WITH ... UPDATE,
// WITH ... DELETE, and other writable CTEs without pulling in a SQL parser.
func firstSQLKeyword(query string) string {
	depth := 0
	withQuery := false
	cteNameExpected := false
	cteBodyExpected := false
	inCTEBody := false
	afterCTEBody := false
	for index := 0; index < len(query); {
		switch query[index] {
		case '\'', '"', '`':
			quote := query[index]
			index++
			for index < len(query) {
				if query[index] == quote {
					if index+1 < len(query) && query[index+1] == quote {
						index += 2
						continue
					}
					index++
					break
				}
				index++
			}
		case '[':
			index++
			for index < len(query) && query[index] != ']' {
				index++
			}
			if index < len(query) {
				index++
			}
		case '-':
			if index+1 < len(query) && query[index+1] == '-' {
				index += 2
				for index < len(query) && query[index] != '\n' {
					index++
				}
				continue
			}
			index++
		case '/':
			if index+1 < len(query) && query[index+1] == '*' {
				index += 2
				for index+1 < len(query) && !(query[index] == '*' && query[index+1] == '/') {
					index++
				}
				if index+1 < len(query) {
					index += 2
				}
				continue
			}
			index++
		case '(':
			depth++
			if withQuery && cteBodyExpected {
				cteBodyExpected = false
				inCTEBody = true
			}
			index++
		case ')':
			if depth > 0 {
				depth--
			}
			if withQuery && inCTEBody && depth == 0 {
				inCTEBody = false
				afterCTEBody = true
			}
			index++
		case ',':
			if withQuery && depth == 0 && afterCTEBody {
				afterCTEBody = false
				cteNameExpected = true
			}
			index++
		default:
			if depth == 0 && isSQLWordStart(query[index]) {
				start := index
				index++
				for index < len(query) && isSQLWordPart(query[index]) {
					index++
				}
				word := strings.ToUpper(query[start:index])
				if !withQuery {
					if word == "WITH" {
						withQuery = true
						cteNameExpected = true
						continue
					}
					return word
				}
				if word == "RECURSIVE" && cteNameExpected {
					continue
				}
				if afterCTEBody {
					return word
				}
				if cteNameExpected {
					cteNameExpected = false
					continue
				}
				if word == "AS" {
					cteBodyExpected = true
					continue
				}
				return word
			}
			index++
		}
	}
	return ""
}

func hasTopLevelStatementSeparator(query string) bool {
	depth := 0
	for index := 0; index < len(query); {
		switch query[index] {
		case '\'', '"', '`':
			quote := query[index]
			index++
			for index < len(query) {
				if query[index] == quote {
					if index+1 < len(query) && query[index+1] == quote {
						index += 2
						continue
					}
					index++
					break
				}
				index++
			}
		case '[':
			index++
			for index < len(query) && query[index] != ']' {
				index++
			}
			if index < len(query) {
				index++
			}
		case '-':
			if index+1 < len(query) && query[index+1] == '-' {
				index += 2
				for index < len(query) && query[index] != '\n' {
					index++
				}
				continue
			}
			index++
		case '/':
			if index+1 < len(query) && query[index+1] == '*' {
				index += 2
				for index+1 < len(query) && !(query[index] == '*' && query[index+1] == '/') {
					index++
				}
				if index+1 < len(query) {
					index += 2
				}
				continue
			}
			index++
		case '(':
			depth++
			index++
		case ')':
			if depth > 0 {
				depth--
			}
			index++
		case ';':
			if depth == 0 && hasSQLContent(query[index+1:]) {
				return true
			}
			index++
		default:
			index++
		}
	}
	return false
}

func hasSQLContent(query string) bool {
	for index := 0; index < len(query); {
		switch query[index] {
		case ' ', '\t', '\r', '\n':
			index++
		case '-':
			if index+1 < len(query) && query[index+1] == '-' {
				index += 2
				for index < len(query) && query[index] != '\n' {
					index++
				}
				continue
			}
			return true
		case '/':
			if index+1 < len(query) && query[index+1] == '*' {
				index += 2
				for index+1 < len(query) && !(query[index] == '*' && query[index+1] == '/') {
					index++
				}
				if index+1 < len(query) {
					index += 2
					continue
				}
				return false
			}
			return true
		default:
			return true
		}
	}
	return false
}

func isSQLWordStart(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value == '_'
}

func isSQLWordPart(value byte) bool {
	return isSQLWordStart(value) || value >= '0' && value <= '9'
}

func normalizeODBCText(data []byte) string {
	return normalizeODBCTextWithEncoding(data, "")
}

func normalizeODBCTextWithEncoding(data []byte, encoding string) string {
	encoding = strings.ToLower(strings.TrimSpace(encoding))
	if encoding == "cp932" || encoding == "shift-jis" || encoding == "shift_jis" {
		decoded, _, err := transform.Bytes(japanese.ShiftJIS.NewDecoder(), data)
		if err == nil {
			return string(decoded)
		}
	}
	if utf8.Valid(data) {
		return string(data)
	}
	decoded, _, err := transform.Bytes(japanese.ShiftJIS.NewDecoder(), data)
	if err == nil {
		return string(decoded)
	}
	return string(data)
}
