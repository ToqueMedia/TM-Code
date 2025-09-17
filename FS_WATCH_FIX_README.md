# Tauri v2 File System Watch Permission Fix

## Problem
The application was encountering an "fs:watch not found" permission error in Tauri v2, even though "fs:watch" was included in the capabilities configuration.

## Root Cause
In Tauri v2, the permission system was restructured and `fs:watch` is no longer a valid standalone permission identifier. Instead, Tauri v2 uses more granular permission identifiers for file system operations.

## Solution
Updated the capability configuration in `src-tauri/capabilities/default.json` with the correct permission identifiers:

1. Replaced `fs:watch` with:
   - `fs:allow-watch` - Permission to use the watch function
   - `fs:allow-watch-immediate` - Permission to use the watchImmediate function

2. Added additional file system permissions required by the application:
   - `fs:allow-read-file` - Read files
   - `fs:allow-write-file` - Write files
   - `fs:allow-read-dir` - Read directories
   - `fs:allow-create-dir` - Create directories
   - `fs:allow-remove-dir` - Remove directories
   - `fs:allow-remove-file` - Remove files
   - `fs:allow-rename` - Rename files/directories

3. Enhanced the fs:scope permissions to cover common user directories where projects might be located:
   - `$HOME/**/*` - User's home directory
   - `$APPDATA/**/*` - Application data directory
   - `$DOCUMENTS/**/*` - Documents directory
   - `$DOWNLOAD/**/*` - Downloads directory
   - `$DESKTOP/**/*` - Desktop directory
   - `$MUSIC/**/*` - Music directory
   - `$PICTURES/**/*` - Pictures directory
   - `$VIDEOS/**/*` - Videos directory
   - `$PUBLIC/**/*` - Public directory
   - `$TEMP/**/*` - Temporary directory

## Tauri v1 vs v2 Permission Changes
| Tauri v1 | Tauri v2 |
|----------|----------|
| `fs:watch` | `fs:allow-watch` and `fs:allow-watch-immediate` |
| Broad permissions | Granular permissions |

## Testing
After applying these changes, the file watching functionality should work correctly without permission errors.

## References
- [Tauri v2 File System Plugin Documentation](https://v2.tauri.app/plugin/fs/)
- [Tauri v2 Permissions Documentation](https://v2.tauri.app/security/)