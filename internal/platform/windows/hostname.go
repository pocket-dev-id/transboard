package windows

import (
	"net"
	"os"
	"sort"
)

func Hostname() string { value, _ := os.Hostname(); return value }

func LocalIPs() []string {
	interfaces, _ := net.Interfaces()
	set := map[string]bool{}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, _ := iface.Addrs()
		for _, address := range addresses {
			if ip, _, err := net.ParseCIDR(address.String()); err == nil && ip.To4() != nil {
				set[ip.String()] = true
			}
		}
	}
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
