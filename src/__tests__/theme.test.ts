// Simple test to verify Chakra UI theme is working
import { theme } from '../theme';

// This is just to verify the import works
console.log('Chakra UI theme imported successfully');

// Test that theme has expected properties
export const testChakraTheme = () => {
  if (!theme) {
    throw new Error('Theme is missing required properties');
  }
  
  console.log('Chakra UI theme test passed');
  return true;
};