import { mergeReplaceArrays } from './mergeReplaceArrays';
import { describe, it, expect } from 'vitest';

describe('mergeReplaceArrays', () => {
    it('should replace arrays instead of concatenating', () => {
        const target = { arr: [1, 2] };
        const source = { arr: [3, 4] };

        const result = mergeReplaceArrays(target, source);
        expect(result.arr).toEqual([3, 4]);
    });

    it('should merge objects recursively', () => {
        const target = {
            obj: { a: 1, b: 2 },
        };
        const source = {
            obj: { b: 3, c: 4 },
        };

        const result = mergeReplaceArrays(target, source);
        expect(result.obj).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('should overwrite primitives', () => {
        const target = { str: 'old', num: 1 };
        const source = { str: 'new', num: 2 };

        const result = mergeReplaceArrays(target, source);
        expect(result).toEqual({ str: 'new', num: 2 });
    });

    it('should handle nested arrays and objects', () => {
        const target = {
            nested: {
                arr: [1, 2],
                obj: { a: 1 },
            },
        };
        const source = {
            nested: {
                arr: [3, 4],
                obj: { b: 2 },
            },
        };

        const result = mergeReplaceArrays(target, source);
        expect(result.nested.arr).toEqual([3, 4]);
        expect(result.nested.obj).toEqual({ a: 1, b: 2 });
    });

    it('should handle empty objects', () => {
        const target = {};
        const source = { a: 1 };
        const result = mergeReplaceArrays(target, source);
        expect(result).toEqual({ a: 1 });
    });

    it('should handle null and undefined values', () => {
        const target = { a: 1, b: null };
        const source = { b: undefined, c: null };
        const result = mergeReplaceArrays(target, source);
        expect(result).toEqual({ a: 1, b: undefined, c: null });
    });

    it('should handle deeply nested arrays', () => {
        const target = {
            level1: {
                level2: {
                    arr: [1, 2, [3, 4]],
                },
            },
        };
        const source = {
            level1: {
                level2: {
                    arr: [5, 6, [7, 8]],
                },
            },
        };
        const result = mergeReplaceArrays(target, source);
        expect(result.level1.level2.arr).toEqual([5, 6, [7, 8]]);
    });

    it('should handle mixed types in arrays', () => {
        const target = {
            mixed: [1, 'two', { three: 3 }, [4, 5]],
        };
        const source = {
            mixed: ['one', 2, { four: 4 }, [6, 7]],
        };
        const result = mergeReplaceArrays(target, source);
        expect(result.mixed).toEqual(['one', 2, { four: 4 }, [6, 7]]);
    });

    it('should preserve array references when source is an array', () => {
        const sourceArray = [1, 2, 3];
        const target = { arr: [4, 5, 6] };
        const result = mergeReplaceArrays(target, { arr: sourceArray });
        expect(result.arr).toStrictEqual(sourceArray);
    });

    it('should handle non-plain objects in arrays', () => {
        class CustomClass {
            value: number;
            constructor(value: number) {
                this.value = value;
            }
        }
        const target = {
            arr: [new CustomClass(1), new CustomClass(2)],
        };
        const source = {
            arr: [new CustomClass(3), new CustomClass(4)],
        };
        const result = mergeReplaceArrays(target, source);
        expect(result.arr).toEqual(source.arr);
    });

    it('should handle arrays at the root level', () => {
        const target = [1, 2, 3];
        const source = [4, 5, 6];
        const result = mergeReplaceArrays(target, source);
        expect(result).toEqual([4, 5, 6]);
    });

    it('should handle arrays with different lengths', () => {
        const target = { arr: [1, 2, 3, 4] };
        const source = { arr: [5, 6] };
        const result = mergeReplaceArrays(target, source);
        expect(result.arr).toEqual([5, 6]);
    });

    it('should handle arrays with empty arrays', () => {
        const target = { arr: [1, 2, [3, 4]] };
        const source = { arr: [] };
        const result = mergeReplaceArrays(target, source);
        expect(result.arr).toEqual([]);
    });

    it('should handle arrays with null values', () => {
        const target = { arr: [1, null, 3] };
        const source = { arr: [4, 5, null] };
        const result = mergeReplaceArrays(target, source);
        expect(result.arr).toEqual([4, 5, null]);
    });

    it('should handle arrays with undefined values', () => {
        const target = { arr: [1, undefined, 3] };
        const source = { arr: [4, 5, undefined] };
        const result = mergeReplaceArrays(target, source);
        expect(result.arr).toEqual([4, 5, undefined]);
    });

    it('should handle arrays with objects that have arrays', () => {
        const target = {
            arr: [{ nested: [1, 2] }, { nested: [3, 4] }],
        };
        const source = {
            arr: [{ nested: [5, 6] }, { nested: [7, 8] }],
        };
        const result = mergeReplaceArrays(target, source);
        expect(result.arr).toEqual(source.arr);
    });

    it('should handle arrays with objects that have nested arrays', () => {
        const target = {
            arr: [{ nested: { deep: [1, 2] } }, { nested: { deep: [3, 4] } }],
        };
        const source = {
            arr: [{ nested: { deep: [5, 6] } }, { nested: { deep: [7, 8] } }],
        };
        const result = mergeReplaceArrays(target, source);
        expect(result.arr).toEqual(source.arr);
    });

    it('should merge three objects with nested structures', () => {
        const obj1 = {
            a: 1,
            nested: {
                x: [1, 2],
                y: { foo: 'bar' },
            },
            arr: [1, 2, 3],
        };
        const obj2 = {
            b: 2,
            nested: {
                y: { baz: 'qux' },
                z: true,
            },
            arr: [4, 5, 6],
        };
        const obj3 = {
            c: 3,
            nested: {
                x: [7, 8],
                w: 42,
            },
            arr: [9, 10],
        };

        const result = mergeReplaceArrays(mergeReplaceArrays(obj1, obj2), obj3);

        expect(result).toEqual({
            a: 1,
            b: 2,
            c: 3,
            nested: {
                x: [7, 8],
                y: { foo: 'bar', baz: 'qux' },
                z: true,
                w: 42,
            },
            arr: [9, 10],
        });
    });

    it('should merge four objects with deeply nested structures', () => {
        const obj1 = {
            config: {
                settings: {
                    theme: 'light',
                    features: ['auth', 'search'],
                },
            },
        };
        const obj2 = {
            config: {
                settings: {
                    theme: 'dark',
                    features: ['chat'],
                },
                api: {
                    url: 'https://api.example.com',
                },
            },
        };
        const obj3 = {
            config: {
                settings: {
                    features: ['notifications'],
                },
                api: {
                    timeout: 5000,
                },
            },
        };
        const obj4 = {
            config: {
                settings: {
                    theme: 'system',
                    features: ['analytics'],
                },
                api: {
                    version: 'v2',
                },
            },
        };

        const result = mergeReplaceArrays(mergeReplaceArrays(mergeReplaceArrays(obj1, obj2), obj3), obj4);

        expect(result).toEqual({
            config: {
                settings: {
                    theme: 'system',
                    features: ['analytics'],
                },
                api: {
                    url: 'https://api.example.com',
                    timeout: 5000,
                    version: 'v2',
                },
            },
        });
    });

    it('should merge five objects with complex nested structures', () => {
        const obj1 = {
            user: {
                preferences: {
                    notifications: {
                        email: true,
                        push: false,
                    },
                },
            },
        };
        const obj2 = {
            user: {
                preferences: {
                    notifications: {
                        push: true,
                    },
                    theme: 'dark',
                },
            },
        };
        const obj3 = {
            user: {
                preferences: {
                    language: 'en',
                },
            },
        };
        const obj4 = {
            user: {
                preferences: {
                    notifications: {
                        sms: true,
                    },
                },
            },
        };
        const obj5 = {
            user: {
                preferences: {
                    notifications: {
                        email: false,
                    },
                    timezone: 'UTC',
                },
            },
        };

        const result = mergeReplaceArrays(mergeReplaceArrays(mergeReplaceArrays(mergeReplaceArrays(obj1, obj2), obj3), obj4), obj5);

        expect(result).toEqual({
            user: {
                preferences: {
                    notifications: {
                        email: false,
                        push: true,
                        sms: true,
                    },
                    theme: 'dark',
                    language: 'en',
                    timezone: 'UTC',
                },
            },
        });
    });
});
