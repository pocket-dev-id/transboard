package windows

import (
	"bufio"
	"os/exec"
	"strings"
)

func ODBCDataSources() map[string]any {
	result := map[string]any{"system": []map[string]string{}, "user": []map[string]string{}, "drivers": []string{}, "views": map[string]any{"system32": []map[string]string{}, "system64": []map[string]string{}, "user32": []map[string]string{}, "user64": []map[string]string{}}}
	for _, view := range []string{"64", "32"} {
		for _, scope := range []struct{ key, registryPath string }{{"system", `HKLM\SOFTWARE\ODBC\ODBC.INI\ODBC Data Sources`}, {"user", `HKCU\Software\ODBC\ODBC.INI\ODBC Data Sources`}} {
			names := queryRegistry(scope.registryPath, view)
			for _, name := range names {
				name["bitness"] = view
				result[scope.key] = append(result[scope.key].([]map[string]string), name)
				viewKey := scope.key + view
				views := result["views"].(map[string]any)
				views[viewKey] = append(views[viewKey].([]map[string]string), name)
			}
		}
		for _, driver := range queryRegistry(`HKLM\SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers`, view) {
			result["drivers"] = append(result["drivers"].([]string), driver["name"])
		}
	}
	return result
}

func queryRegistry(path, view string) []map[string]string {
	command := exec.Command("reg.exe", "query", path, "/reg:"+view)
	output, err := command.Output()
	if err != nil {
		return nil
	}
	var result []map[string]string
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 3 && fields[1] == "REG_SZ" {
			result = append(result, map[string]string{"name": fields[0], "driver": strings.Join(fields[2:], " ")})
		}
	}
	return result
}
