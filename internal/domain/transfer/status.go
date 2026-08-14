package transfer

import "fmt"

type Status string

const (
	InBed            Status = "IN_BED"
	DepartRegistered Status = "DEPART_REGISTERED"
	Moving           Status = "MOVING"
	Arrived          Status = "ARRIVED"
	InExam           Status = "IN_EXAM"
	NearlyDone       Status = "NEARLY_DONE"
	PickupRequired   Status = "PICKUP_REQUIRED"
	Returned         Status = "RETURNED"
	Cancelled        Status = "CANCELLED"
)

var AllStatuses = []Status{
	InBed, DepartRegistered, Moving, Arrived, InExam, NearlyDone,
	PickupRequired, Returned, Cancelled,
}

var WardActions = map[Status][]Status{
	DepartRegistered: []Status{Moving, InExam, Cancelled},
	Moving:           []Status{Arrived, InExam, Cancelled},
	Arrived:          []Status{InExam, Cancelled},
	InExam:           []Status{NearlyDone, PickupRequired, Returned, Cancelled},
	NearlyDone:       []Status{PickupRequired, Cancelled},
	PickupRequired:   []Status{Returned, Cancelled},
	Returned:         []Status{},
	Cancelled:        []Status{},
}

var ExamActions = map[Status][]Status{
	DepartRegistered: []Status{Arrived},
	Moving:           []Status{Arrived},
	Arrived:          []Status{InExam},
	InExam:           []Status{NearlyDone, PickupRequired},
	NearlyDone:       []Status{PickupRequired},
	PickupRequired:   []Status{},
}

func Known(status string) bool {
	for _, candidate := range AllStatuses {
		if string(candidate) == status {
			return true
		}
	}
	return false
}

// NormalizeLegacyStatus is intentionally conservative. It only rewrites the
// retired departure marker; unknown values are returned as errors so a damaged
// database can never be silently turned into a valid transfer.
func NormalizeLegacyStatus(value string) (Status, bool, error) {
	if value == string(DepartRegistered) {
		return Moving, true, nil
	}
	if !Known(value) {
		return "", false, fmt.Errorf("unknown transfer status %q", value)
	}
	return Status(value), false, nil
}

func Allowed(scope string, from, to Status) bool {
	if from == to {
		return true
	}
	actions := WardActions
	if scope == "exam" {
		actions = ExamActions
	}
	for _, target := range actions[from] {
		if target == to {
			return true
		}
	}
	return false
}

func TimestampField(status Status) string {
	switch status {
	case Moving:
		return "departed_at"
	case Arrived:
		return "arrived_at"
	case InExam:
		return "exam_started_at"
	case NearlyDone:
		return "nearly_done_at"
	case PickupRequired:
		return "pickup_ready_at"
	case Returned:
		return "returned_at"
	case Cancelled:
		return "cancelled_at"
	default:
		return ""
	}
}

type Transition struct {
	From   Status
	To     Status
	Scope  string
	Actor  string
	Reason string
}

type Service struct{}

func (Service) Apply(scope string, from, to Status) (Transition, error) {
	if !Known(string(from)) || !Known(string(to)) {
		return Transition{}, fmt.Errorf("unknown transition status: %s -> %s", from, to)
	}
	if !Allowed(scope, from, to) {
		return Transition{}, fmt.Errorf("invalid %s transition: %s -> %s", scope, from, to)
	}
	return Transition{From: from, To: to, Scope: scope}, nil
}
