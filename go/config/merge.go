package config

// MergeReplaceArrays performs a deep merge where:
//   - Slices (arrays) from source replace target entirely
//   - Maps (objects) merge recursively
//   - Other values (primitives) from source overwrite target
func MergeReplaceArrays(target, source any) any {
	// If source is a slice, replace entirely
	if sourceSlice, ok := source.([]any); ok {
		result := make([]any, len(sourceSlice))
		copy(result, sourceSlice)
		return result
	}

	// If source is a map, merge recursively
	if sourceMap, ok := source.(map[string]any); ok {
		var targetMap map[string]any
		if tm, ok := target.(map[string]any); ok {
			targetMap = make(map[string]any, len(tm))
			for k, v := range tm {
				targetMap[k] = v
			}
		} else {
			targetMap = make(map[string]any)
		}
		for key, value := range sourceMap {
			if existing, exists := targetMap[key]; exists {
				targetMap[key] = MergeReplaceArrays(existing, value)
			} else {
				targetMap[key] = value
			}
		}
		return targetMap
	}

	// Primitive or other: source overwrites
	return source
}
