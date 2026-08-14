package main

import (
	"embed"
	"log"

	"github.com/pocket-dev-id/transboard/internal/application"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

// The frontend is embedded into the Wails binary so the desktop runtime has no
// dependency on a Node.js process or a separately installed browser server.
//
//go:embed frontend
var frontendAssets embed.FS

func main() {
	service, err := application.New(application.Options{})
	if err != nil {
		log.Fatal(err)
	}

	app := NewApp(service)
	err = wails.Run(&options.App{
		Title:  "TransBoard",
		Width:  1440,
		Height: 900,
		AssetServer: &assetserver.Options{
			Assets: frontendAssets,
		},
		BackgroundColour: &options.RGBA{R: 248, G: 250, B: 252, A: 255},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			DisableWindowIcon:    false,
			EnableSwipeGestures:  false,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
