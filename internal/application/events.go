package application

type EventSink func(name string, payload any)

func (a *App) emit(name string, payload any) {
	a.mu.RLock()
	sink := a.eventSink
	a.mu.RUnlock()
	if sink != nil {
		sink(name, payload)
	}
}
