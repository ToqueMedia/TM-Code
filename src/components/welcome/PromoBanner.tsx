import { useState, useEffect } from 'react'
import { Box, HStack, Text, Badge, Button, Icon } from '@chakra-ui/react'
import { LuArrowRight } from 'react-icons/lu'
import { usePromotionsStore, filterActivePromotions } from '../../stores/promotionsStore'
import { useBillingStore } from '../../stores/billingStore'
import { useProjectStore } from '../../stores/projectStore'

function usePromoCountdown(endsAt: string) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!endsAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [endsAt])
  if (!endsAt) return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true }
  const end = new Date(endsAt).getTime()
  const remaining = Math.max(0, end - now)
  if (remaining <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true }
  return {
    days: Math.floor(remaining / 86400000),
    hours: Math.floor((remaining % 86400000) / 3600000),
    minutes: Math.floor((remaining % 3600000) / 60000),
    seconds: Math.floor((remaining % 60000) / 1000),
    expired: false,
  }
}

/**
 * Promotion banner rendered inside WelcomeHero's {children} slot.
 * Returns null when no active promotions exist — the WelcomeHero guard
 * `{children && ...}` handles this gracefully.
 */
export default function PromoBanner() {
  const { promotions, isLoaded } = usePromotionsStore()
  const plan = useBillingStore(s => s.plan)
  const setWelcomeScreen = useProjectStore(s => s.setWelcomeScreen)

  if (!isLoaded || promotions.length === 0) return null

  const active = filterActivePromotions(promotions, 'ide', plan)
  if (active.length === 0) return null

  const promo = active[0]

  function handleCta() {
    // User is already in the app — navigate to settings/billing
    setWelcomeScreen('settings')
  }

  return <PromoBannerInner promo={promo} onCta={handleCta} />
}

function PromoBannerInner({ promo, onCta }: { promo: { endsAt: string; color: string; badge: string; title: string; description: string; ctaText: string; discountPercent: number }; onCta: () => void }) {
  const { days, hours, minutes, seconds, expired } = usePromoCountdown(promo.endsAt)
  if (expired) return null

  return (
    <Box
      bg="rgba(255,255,255,0.04)"
      backdropFilter="blur(16px)"
      border="1px solid"
      borderColor={promo.color + '30'}
      borderRadius="16px"
      px={5}
      py={3}
      display="flex"
      alignItems="center"
      justifyContent="space-between"
      flexDirection={{ base: 'column', sm: 'row' }}
      gap={3}
      w="100%"
      maxW="640px"
      mx="auto"
    >
      <HStack gap={2} align="center" flexWrap="wrap">
        {(promo.badge || (promo.discountPercent && promo.discountPercent > 0)) && (
          <Badge
            bg={promo.color}
            color="white"
            fontSize="2xs"
            px={2}
            py={0.5}
            borderRadius="full"
            fontWeight="bold"
            textTransform="none"
          >
            {promo.discountPercent && promo.discountPercent > 0 ? `${promo.discountPercent}% OFF` : promo.badge}
          </Badge>
        )}
        <Text color="white" fontWeight="semibold" fontSize="sm">
          {promo.title}
        </Text>
        {promo.description && (
          <Text color="gray.400" fontSize="xs">
            — {promo.description}
          </Text>
        )}
      </HStack>
      <HStack gap={3} align="center">
        {/* Countdown */}
        <HStack gap={1.5}>
          {[
            { v: days, l: 'd' },
            { v: hours, l: 'h' },
            { v: minutes, l: 'm' },
            { v: seconds, l: 's' },
          ].map((u, i) => (
            <HStack key={i} gap={0.5}>
              <Text fontSize="xs" fontWeight="black" fontFamily="mono" color="white" minW="16px" textAlign="center">
                {String(u.v).padStart(2, '0')}
              </Text>
              <Text fontSize="2xs" color="gray.500">{u.l}</Text>
              {i < 3 && <Text fontSize="xs" color="gray.600" mx={0.3}>:</Text>}
            </HStack>
          ))}
        </HStack>
        <Button
          size="sm"
          bg={promo.color}
          color="white"
          borderRadius="full"
          px={4}
          h="28px"
          fontSize="xs"
          fontWeight="semibold"
          _hover={{ opacity: 0.85 }}
          _active={{ opacity: 0.7 }}
          onClick={onCta}
          flexShrink={0}
        >
          {promo.ctaText}
          <Icon as={LuArrowRight} ml={1} />
        </Button>
      </HStack>
    </Box>
  )
}
