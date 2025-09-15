#!/bin/bash

# Test script for Diamond IDE implementation

echo "Testing Diamond IDE implementation..."

# Check if required files exist
echo "Checking for required files..."

REQUIRED_FILES=(
  "project-management-prompt.md"
  "README.md"
  "src/theme.ts"
  "src/components/WelcomeScreen.tsx"
  "src/components/Editor.tsx"
  "src/App.tsx"
)

MISSING_FILES=()

for file in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    echo "❌ Missing file: $file"
    MISSING_FILES+=("$file")
  else
    echo "✅ Found file: $file"
  fi
done

if [ ${#MISSING_FILES[@]} -eq 0 ]; then
  echo "✅ All required files are present"
else
  echo "❌ Missing ${#MISSING_FILES[@]} required files"
  exit 1
fi

# Check if package.json has been updated
if grep -q "test:components" package.json; then
  echo "✅ package.json has been updated with test:components script"
else
  echo "❌ package.json has not been updated with test:components script"
  exit 1
fi

# Try to build the project
echo "Attempting to build the project..."
npm run build

if [ $? -eq 0 ]; then
  echo "✅ Project builds successfully"
else
  echo "❌ Project failed to build"
  exit 1
fi

echo "🎉 All tests passed! Diamond IDE implementation is ready."