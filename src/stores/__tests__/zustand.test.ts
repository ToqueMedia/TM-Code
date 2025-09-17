// Simple test to verify Zustand store is working
import { useProjectStore } from '../projectStore';

// This is just to verify the import works
console.log('Project store imported successfully');

// In a real test, we would use Jest or similar testing framework
export const testZustandStore = () => {
  // Access the store to verify it's working
  const state = useProjectStore.getState();
  console.log('Zustand store test placeholder', state);
  return true;
};