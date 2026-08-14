package backup

import (
	"fmt"

	"github.com/pocket-dev-id/transboard/internal/database"
)

func ValidateDB(db database.DB) error {
	if db == nil {
		return fmt.Errorf("backup database is empty")
	}
	for _, table := range database.TableNames {
		if _, ok := db[table]; !ok {
			return fmt.Errorf("missing table %s", table)
		}
	}
	for _, event := range database.Rows(db, "transfer_events") {
		if event["id"] == nil || event["current_status"] == nil {
			return fmt.Errorf("invalid transfer event")
		}
	}
	return nil
}

func RedactPatients(db database.DB) { database.RedactPatients(db) }
