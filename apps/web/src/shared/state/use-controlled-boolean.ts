import { useCallback, useState } from 'react'

export function useControlledBoolean(
  value: boolean | undefined,
  onChange: ((next: boolean) => void) | undefined,
): readonly [boolean, (next: boolean) => void] {
  const [internalValue, setInternalValue] = useState(false)
  const setValue = useCallback((next: boolean) => {
    if (onChange) onChange(next)
    else setInternalValue(next)
  }, [onChange])
  return [value ?? internalValue, setValue]
}
