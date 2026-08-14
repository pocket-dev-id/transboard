//go:build windows

package importer

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/alexbrainman/odbc"
)

type SQLODBCProvider struct{}

func NewODBCProvider() ODBCProvider { return SQLODBCProvider{} }

func (SQLODBCProvider) open(ctx context.Context, config ODBCConfig) (*sql.DB, error) {
	if config.ConnectionString == "" {
		return nil, fmt.Errorf("ODBC connection string is required")
	}
	db, err := sql.Open("odbc", config.ConnectionString)
	if err != nil {
		return nil, fmt.Errorf("open ODBC connection: %w", err)
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("test ODBC connection: %w", err)
	}
	return db, nil
}

func (p SQLODBCProvider) TestConnection(ctx context.Context, config ODBCConfig) error {
	db, err := p.open(ctx, config)
	if err != nil {
		return err
	}
	return db.Close()
}

func (p SQLODBCProvider) Tables(ctx context.Context, config ODBCConfig) ([]map[string]string, error) {
	db, err := p.open(ctx, config)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES")
	if err != nil {
		return nil, fmt.Errorf("list ODBC tables: %w", err)
	}
	defer rows.Close()
	result := make([]map[string]string, 0)
	for rows.Next() {
		var schema, name, tableType string
		if err := rows.Scan(&schema, &name, &tableType); err != nil {
			return nil, err
		}
		result = append(result, map[string]string{"schema": schema, "name": name, "type": tableType})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (p SQLODBCProvider) Query(ctx context.Context, config ODBCConfig) ([]ODBCRecord, error) {
	if err := validateReadQuery(config.Query); err != nil {
		return nil, err
	}
	db, err := p.open(ctx, config)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, config.Query)
	if err != nil {
		return nil, fmt.Errorf("run ODBC query: %w", err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	limit := config.MaxRows
	if limit <= 0 || limit > 10000 {
		limit = 1000
	}
	result := make([]ODBCRecord, 0, limit)
	for rows.Next() && len(result) < limit {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, fmt.Errorf("scan ODBC row: %w", err)
		}
		record := ODBCRecord{}
		for i, column := range columns {
			record[column] = normalizeODBCValue(values[i], config.Encoding)
		}
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func normalizeODBCValue(value any, encoding string) any {
	switch typed := value.(type) {
	case []byte:
		return normalizeODBCTextWithEncoding(typed, encoding)
	case time.Time:
		return typed.Format(time.RFC3339Nano)
	default:
		return value
	}
}
