package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestMerge_StringOverwritesString(t *testing.T) {
	assert.Equal(t, "new", MergeReplaceArrays("old", "new"))
}

func TestMerge_NumberOverwritesNumber(t *testing.T) {
	assert.Equal(t, 2.0, MergeReplaceArrays(1.0, 2.0))
}

func TestMerge_BoolOverwritesBool(t *testing.T) {
	assert.Equal(t, false, MergeReplaceArrays(true, false))
}

func TestMerge_NilOverwritesValue(t *testing.T) {
	assert.Nil(t, MergeReplaceArrays("hello", nil))
}

func TestMerge_ValueOverwritesNil(t *testing.T) {
	assert.Equal(t, "hello", MergeReplaceArrays(nil, "hello"))
}

func TestMerge_ArrayReplacesArray(t *testing.T) {
	target := []any{1.0, 2.0, 3.0}
	source := []any{4.0, 5.0}
	result := MergeReplaceArrays(target, source)
	assert.Equal(t, []any{4.0, 5.0}, result)
}

func TestMerge_ArrayReplacesCompletely(t *testing.T) {
	target := []any{1.0, 2.0, 3.0}
	source := []any{}
	result := MergeReplaceArrays(target, source)
	assert.Equal(t, []any{}, result)
}

func TestMerge_ArrayReplacesNonArray(t *testing.T) {
	result := MergeReplaceArrays("not-array", []any{1.0, 2.0})
	assert.Equal(t, []any{1.0, 2.0}, result)
}

func TestMerge_ArrayIsNewCopy(t *testing.T) {
	source := []any{1.0, 2.0, 3.0}
	result := MergeReplaceArrays([]any{}, source).([]any)
	assert.Equal(t, source, result)
	// Verify it's a copy
	source[0] = 99.0
	assert.NotEqual(t, source[0], result[0])
}

func TestMerge_FlatObjectMerge(t *testing.T) {
	target := map[string]any{"a": 1.0, "b": 2.0}
	source := map[string]any{"b": 3.0, "c": 4.0}
	result := MergeReplaceArrays(target, source)
	assert.Equal(t, map[string]any{"a": 1.0, "b": 3.0, "c": 4.0}, result)
}

func TestMerge_NestedObjectMerge(t *testing.T) {
	target := map[string]any{"a": map[string]any{"x": 1.0, "y": 2.0}, "b": 3.0}
	source := map[string]any{"a": map[string]any{"y": 10.0, "z": 20.0}}
	result := MergeReplaceArrays(target, source)
	expected := map[string]any{"a": map[string]any{"x": 1.0, "y": 10.0, "z": 20.0}, "b": 3.0}
	assert.Equal(t, expected, result)
}

func TestMerge_DeeplyNestedMerge(t *testing.T) {
	target := map[string]any{"a": map[string]any{"b": map[string]any{"c": 1.0, "d": 2.0}}}
	source := map[string]any{"a": map[string]any{"b": map[string]any{"d": 3.0, "e": 4.0}}}
	result := MergeReplaceArrays(target, source)
	expected := map[string]any{"a": map[string]any{"b": map[string]any{"c": 1.0, "d": 3.0, "e": 4.0}}}
	assert.Equal(t, expected, result)
}

func TestMerge_ObjectOverwritesNonObject(t *testing.T) {
	result := MergeReplaceArrays("not-object", map[string]any{"a": 1.0})
	assert.Equal(t, map[string]any{"a": 1.0}, result)
}

func TestMerge_ArrayInObjectReplaced(t *testing.T) {
	target := map[string]any{"a": []any{1.0, 2.0, 3.0}, "b": "keep"}
	source := map[string]any{"a": []any{4.0, 5.0}}
	result := MergeReplaceArrays(target, source)
	assert.Equal(t, map[string]any{"a": []any{4.0, 5.0}, "b": "keep"}, result)
}

func TestMerge_PrimitiveReplacesObject(t *testing.T) {
	target := map[string]any{"a": map[string]any{"x": 1.0}}
	source := map[string]any{"a": 42.0}
	result := MergeReplaceArrays(target, source)
	assert.Equal(t, map[string]any{"a": 42.0}, result)
}

func TestMerge_ObjectReplacesPrimitive(t *testing.T) {
	target := map[string]any{"a": 42.0}
	source := map[string]any{"a": map[string]any{"x": 1.0}}
	result := MergeReplaceArrays(target, source)
	assert.Equal(t, map[string]any{"a": map[string]any{"x": 1.0}}, result)
}

func TestMerge_EmptySourcePreservesTarget(t *testing.T) {
	target := map[string]any{"a": 1.0, "b": 2.0}
	result := MergeReplaceArrays(target, map[string]any{})
	assert.Equal(t, map[string]any{"a": 1.0, "b": 2.0}, result)
}

func TestMerge_EmptyTargetUsesSource(t *testing.T) {
	source := map[string]any{"a": 1.0, "b": 2.0}
	result := MergeReplaceArrays(map[string]any{}, source)
	assert.Equal(t, map[string]any{"a": 1.0, "b": 2.0}, result)
}

func TestMerge_BothEmpty(t *testing.T) {
	result := MergeReplaceArrays(map[string]any{}, map[string]any{})
	assert.Equal(t, map[string]any{}, result)
}

func TestMerge_PartialDatabaseOverride(t *testing.T) {
	base := map[string]any{
		"DATABASE": map[string]any{"host": "prod-db.example.com", "port": 5432.0, "ssl": true},
		"API_URL":  "https://api.example.com",
	}
	override := map[string]any{
		"DATABASE": map[string]any{"host": "aws-prod-db.example.com"},
	}
	result := MergeReplaceArrays(base, override)
	expected := map[string]any{
		"DATABASE": map[string]any{"host": "aws-prod-db.example.com", "port": 5432.0, "ssl": true},
		"API_URL":  "https://api.example.com",
	}
	assert.Equal(t, expected, result)
}

func TestMerge_DoesNotMutateTarget(t *testing.T) {
	inner := map[string]any{"x": 1.0}
	target := map[string]any{"a": inner, "b": 2.0}
	source := map[string]any{"a": map[string]any{"y": 3.0}}
	MergeReplaceArrays(target, source)
	// Original target's inner map should not be mutated
	assert.Equal(t, map[string]any{"x": 1.0}, inner)
}
