1. Fix FileTree state persistence with Zustand persist
Update the `fileTreeStore` to persist the `expandedPaths` state using Zustand's persist middleware. This will maintain the expanded/collapsed state of folders across page refreshes and IDE re-entries. Also ensure the last active document is restored when returning to the IDE.

Key changes:
- Add persist middleware to `fileTreeStore` 
- Store `expandedPaths` set as an array in localStorage
- Store `selectedFile` path to restore active document
- Handle hydration properly to convert stored array back to Set
2. Fix Editor content caching issues
Investigate and fix the issue where some files display incorrect content from previously opened files. The problem likely stems from improper content caching in the `editorStore`.

Key changes:
- Review `getFileContent` method in `editorStore`
- Ensure proper cache invalidation when switching files
- Verify content is correctly mapped to file paths
- Clear stale cache entries when files are closed
3. Fix ExplorerPanel refresh button functionality
Update the refresh button to only reload the file tree instead of refreshing the entire application with `window.location.reload()`.

Key changes:
- Locate refresh button in `ExplorerPanel` component
- Replace `window.location.reload()` with `fileTreeStore.refresh()`
- Ensure the refresh method properly updates the file tree without losing state
4. Implement auto-expand behavior for folder selection
Modify the TreeNode component to automatically expand folders when they are selected, improving UX by eliminating the need for separate clicks to select and expand.

Key changes:
- Update `handleSelect` method in `TreeNode` component
- When a folder is selected, automatically add it to `expandedPaths`
- Ensure smooth transition and state update
5. Add resizable panels with persistent sizing
Implement manual resizing capabilities for the ExplorerPanel (left sidebar) and BottomPanel (terminal/output area) with size persistence in localStorage.

Key changes:
- Add resize handles between panels using CSS resize property or custom drag handles
- Implement drag-to-resize functionality with proper constraints
- Store panel sizes in localStorage
- Restore saved sizes on component mount
- Add minimum/maximum size constraints for usability