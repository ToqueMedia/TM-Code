import { memo } from 'react'
import { Box, Flex } from '@chakra-ui/react'
import { ShimmerStyle, SkeletonLine, SkeletonRect } from './Skeleton'
import { tokens } from '@/theme/tokens'

/** Simulated tree entry: indentation level + line width. */
const treeItems: Array<{ indent: number; width: string; isFolder?: boolean }> = [
  { indent: 0, width: '55%', isFolder: true },
  { indent: 1, width: '45%' },
  { indent: 1, width: '60%' },
  { indent: 1, width: '40%', isFolder: true },
  { indent: 2, width: '50%' },
  { indent: 2, width: '35%' },
  { indent: 0, width: '50%', isFolder: true },
  { indent: 1, width: '65%' },
  { indent: 1, width: '40%' },
  { indent: 0, width: '45%' },
]

/**
 * Skeleton shown while the file tree is loading for the first time.
 * Renders 10 indented placeholder rows simulating a tree structure.
 */
const FileTreeSkeleton = memo(function FileTreeSkeleton() {
  return (
    <Box px={3} py={3}>
      <ShimmerStyle />
      {treeItems.map((item, i) => (
        <Flex
          key={i}
          align="center"
          gap={2}
          py="4px"
          pl={`${item.indent * 16 + 4}px`}
        >
          {item.isFolder && (
            <SkeletonRect
              width="14px"
              height="14px"
              borderRadius={tokens.radius.sm}
            />
          )}
          {!item.isFolder && (
            <SkeletonRect
              width="14px"
              height="14px"
              borderRadius={tokens.radius.sm}
            />
          )}
          <SkeletonLine width={item.width} height="11px" />
        </Flex>
      ))}
    </Box>
  )
})

export default FileTreeSkeleton
