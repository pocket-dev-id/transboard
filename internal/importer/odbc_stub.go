//go:build !windows

package importer

func NewODBCProvider() ODBCProvider { return UnsupportedODBC{} }
