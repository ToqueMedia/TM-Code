import { Flex } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import {
  primaryBtnStyle, primaryHoverEnter, primaryHoverLeave,
  secondaryBtnStyle, secondaryHoverEnter, secondaryHoverLeave,
} from './onboardingStyles'

const MotionFlex = motion.create(Flex)

interface OnboardingNavProps {
  onBack?: () => void
  onNext: () => void
  backLabel?: string
  nextLabel?: string
  delay?: number
  nextDisabled?: boolean
}

function OnboardingNav({ onBack, onNext, backLabel = 'Back', nextLabel = 'Continue', delay = 0.4, nextDisabled = false }: OnboardingNavProps) {
  return (
    <MotionFlex
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ delay }}
      gap={3}
      justify="center"
    >
      {onBack && (
        <button
          type="button"
          className="ob-btn"
          onClick={onBack}
          style={{ ...secondaryBtnStyle, padding: '11px 26px' }}
          onMouseEnter={secondaryHoverEnter}
          onMouseLeave={secondaryHoverLeave}
        >
          {backLabel}
        </button>
      )}
      <button
        type="button"
        className="ob-btn ob-btn-primary"
        onClick={nextDisabled ? undefined : onNext}
        disabled={nextDisabled}
        style={{
          ...primaryBtnStyle,
          padding: '11px 36px',
          opacity: nextDisabled ? 0.4 : 1,
          cursor: nextDisabled ? 'not-allowed' : 'pointer',
        }}
        onMouseEnter={nextDisabled ? undefined : primaryHoverEnter}
        onMouseLeave={nextDisabled ? undefined : primaryHoverLeave}
      >
        {nextLabel}
      </button>
    </MotionFlex>
  )
}

export default OnboardingNav
