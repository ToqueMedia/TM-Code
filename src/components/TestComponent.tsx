import { useState } from 'react';
import { Button, Card, Flex, Heading, Text } from '@chakra-ui/react';

export function TestComponent() {
  const [count, setCount] = useState(0);

  return (
    <Flex minHeight="100vh" alignItems="center" justifyContent="center" bg="bg.welcome">
      <Card.Root>
        <Card.Body>
          <Heading mb={4}>Project Management System Test</Heading>
          <Text mb={4}>This is a test component to verify our setup is working correctly.</Text>
          <Text mb={4}>Count: {count}</Text>
          <Button onClick={() => setCount(c => c + 1)}>Increment</Button>
        </Card.Body>
      </Card.Root>
    </Flex>
  );
}