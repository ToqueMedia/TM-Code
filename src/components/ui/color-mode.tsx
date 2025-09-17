import type { ReactNode } from "react"
import { createContext, useContext } from "react"

type ColorMode = "light" | "dark" | "system"

interface ColorModeContextType {
  colorMode: ColorMode
  setColorMode: (value: ColorMode) => void
  toggleColorMode: () => void
}

const ColorModeContext = createContext<ColorModeContextType | undefined>(undefined)

export interface ColorModeProviderProps {
  children?: ReactNode
  value?: ColorMode
}

export function ColorModeProvider({ children, value = "dark" }: ColorModeProviderProps) {
  const setColorMode = (newValue: ColorMode) => {
    // For now, we'll default to dark mode for the editor
    console.log("Setting color mode:", newValue)
  }

  const toggleColorMode = () => {
    // Toggle between light and dark
    setColorMode(value === "light" ? "dark" : "light")
  }

  const contextValue = {
    colorMode: value,
    setColorMode,
    toggleColorMode,
  }

  return (
    <ColorModeContext.Provider value={contextValue}>
      {children}
    </ColorModeContext.Provider>
  )
}

export function useColorMode() {
  const context = useContext(ColorModeContext)
  if (context === undefined) {
    throw new Error("useColorMode must be used within a ColorModeProvider")
  }
  return context
}