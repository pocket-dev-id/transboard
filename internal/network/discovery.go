package network

import (
	"fmt"
	"net"
	"sort"
)

func LocalIPs() []string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return []string{}
	}
	set := map[string]bool{}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, _ := iface.Addrs()
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil && ip.To4() != nil {
				set[ip.String()] = true
			}
		}
	}
	result := make([]string, 0, len(set))
	for ip := range set {
		result = append(result, ip)
	}
	sort.Strings(result)
	return result
}

func IsPrivateIPv4(value string) bool {
	ip := net.ParseIP(value).To4()
	if ip == nil {
		return false
	}
	return ip[0] == 10 || ip[0] == 127 ||
		(ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) ||
		(ip[0] == 192 && ip[1] == 168)
}

func ValidateParentAddress(host string, port int) error {
	if !IsPrivateIPv4(host) {
		return fmt.Errorf("parent address must be a private IPv4 address")
	}
	if port < 1 || port > 65535 {
		return fmt.Errorf("invalid parent port")
	}
	return nil
}
