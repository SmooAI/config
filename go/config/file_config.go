package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

var (
	configDirCache   string
	configDirCacheAt time.Time
	configDirCacheMu sync.Mutex
	configDirTTL     = time.Hour
)

// ResetConfigDirCache clears the config directory cache (for testing).
func ResetConfigDirCache() {
	configDirCacheMu.Lock()
	configDirCache = ""
	configDirCacheMu.Unlock()
}

// FindConfigDirectory finds the directory where JSON config files are located.
//
// Search order:
//  1. SMOOAI_ENV_CONFIG_DIR env var
//  2. CWD/.smooai-config or CWD/smooai-config
//  3. Walk up directory tree (max 5 levels)
func FindConfigDirectory(ignoreCache bool) (string, error) {
	return findConfigDirectoryWithEnv(ignoreCache, osEnvMap())
}

func findConfigDirectoryWithEnv(ignoreCache bool, env map[string]string) (string, error) {
	// 1. SMOOAI_ENV_CONFIG_DIR
	if dir := env["SMOOAI_ENV_CONFIG_DIR"]; dir != "" {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir, nil
		}
		return "", NewConfigError(fmt.Sprintf("directory in SMOOAI_ENV_CONFIG_DIR does not exist: %s", dir))
	}

	// 2. Check cache
	if !ignoreCache {
		configDirCacheMu.Lock()
		if configDirCache != "" && time.Since(configDirCacheAt) < configDirTTL {
			dir := configDirCache
			configDirCacheMu.Unlock()
			if info, err := os.Stat(dir); err == nil && info.IsDir() {
				return dir, nil
			}
			configDirCacheMu.Lock()
			configDirCache = ""
			configDirCacheMu.Unlock()
		} else {
			configDirCacheMu.Unlock()
		}
	}

	// 3. CWD candidates
	cwd, err := os.Getwd()
	if err != nil {
		return "", NewConfigError(fmt.Sprintf("failed to get working directory: %v", err))
	}

	candidates := []string{".smooai-config", "smooai-config"}

	for _, c := range candidates {
		dir := filepath.Join(cwd, c)
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			configDirCacheMu.Lock()
			configDirCache = dir
			configDirCacheAt = time.Now()
			configDirCacheMu.Unlock()
			return dir, nil
		}
	}

	// 4. Walk up
	levelsUp := 5
	if v := env["SMOOAI_CONFIG_LEVELS_UP_LIMIT"]; v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			levelsUp = n
		}
	}

	searchDir := cwd
	for range levelsUp {
		parent := filepath.Dir(searchDir)
		if parent == searchDir {
			break // reached root
		}
		searchDir = parent
		for _, c := range candidates {
			dir := filepath.Join(searchDir, c)
			if info, err := os.Stat(dir); err == nil && info.IsDir() {
				configDirCacheMu.Lock()
				configDirCache = dir
				configDirCacheAt = time.Now()
				configDirCacheMu.Unlock()
				return dir, nil
			}
		}
	}

	return "", NewConfigError(fmt.Sprintf("could not find config directory, searched %d levels up from %s", levelsUp, cwd))
}

// FindAndProcessFileConfig loads and merges JSON config files.
//
// Merge order:
//  1. default.json (REQUIRED)
//  2. local.json (if IS_LOCAL is truthy)
//  3. {env}.json
//  4. {env}.{provider}.json
//  5. {env}.{provider}.{region}.json
func FindAndProcessFileConfig() (map[string]any, error) {
	return findAndProcessFileConfigWithEnv(osEnvMap())
}

func findAndProcessFileConfigWithEnv(env map[string]string) (map[string]any, error) {
	configDir, err := findConfigDirectoryWithEnv(false, env)
	if err != nil {
		return nil, err
	}

	isLocal := CoerceBoolean(env["IS_LOCAL"])
	envName := env["SMOOAI_CONFIG_ENV"]
	if envName == "" {
		envName = "development"
	}
	cloudRegion := GetCloudRegionFromEnv(env)

	// Build file list
	files := []string{"default.json"}
	if isLocal {
		files = append(files, "local.json")
	}
	if envName != "" {
		files = append(files, envName+".json")
		if cloudRegion.Provider != "" && cloudRegion.Provider != "unknown" {
			files = append(files, fmt.Sprintf("%s.%s.json", envName, cloudRegion.Provider))
			if cloudRegion.Region != "" && cloudRegion.Region != "unknown" {
				files = append(files, fmt.Sprintf("%s.%s.%s.json", envName, cloudRegion.Provider, cloudRegion.Region))
			}
		}
	}

	finalConfig := make(map[string]any)

	for _, fileName := range files {
		filePath := filepath.Join(configDir, fileName)
		data, err := os.ReadFile(filePath)
		if err != nil {
			if os.IsNotExist(err) {
				if fileName == "default.json" {
					return nil, NewConfigError(fmt.Sprintf("required default.json not found in %s", configDir))
				}
				continue // optional file
			}
			return nil, NewConfigError(fmt.Sprintf("error reading %s: %v", filePath, err))
		}

		var fileConfig map[string]any
		if err := json.Unmarshal(data, &fileConfig); err != nil {
			return nil, NewConfigError(fmt.Sprintf("error parsing %s: %v", filePath, err))
		}

		merged := MergeReplaceArrays(finalConfig, fileConfig)
		if m, ok := merged.(map[string]any); ok {
			finalConfig = m
		}
	}

	// Set built-in keys
	finalConfig["ENV"] = envName
	finalConfig["IS_LOCAL"] = isLocal
	finalConfig["REGION"] = cloudRegion.Region
	finalConfig["CLOUD_PROVIDER"] = cloudRegion.Provider

	return finalConfig, nil
}
