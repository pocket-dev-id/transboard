package patient

type Patient struct {
	ID   string `json:"patient_id,omitempty"`
	Name string `json:"patient_name,omitempty"`
}
