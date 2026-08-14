package schedule

type Item struct {
	ID       string `json:"id"`
	FeedID   string `json:"feed_id"`
	Title    string `json:"title"`
	StartsAt int64  `json:"starts_at"`
}
