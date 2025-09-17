// Example of implementing toast notifications in Chakra UI v3
import React from 'react';
import { Button, useToast } from '@chakra-ui/react';

const ToastExample: React.FC = () => {
  const toast = useToast();

  const showSuccessToast = () => {
    toast({
      title: 'Success!',
      description: 'Your action was completed successfully.',
      status: 'success',
      duration: 5000,
      isClosable: true,
    });
  };

  const showErrorToast = () => {
    toast({
      title: 'Error occurred',
      description: 'Something went wrong. Please try again.',
      status: 'error',
      duration: 5000,
      isClosable: true,
    });
  };

  const showWarningToast = () => {
    toast({
      title: 'Warning',
      description: 'This action requires your attention.',
      status: 'warning',
      duration: 5000,
      isClosable: true,
    });
  };

  const showInfoToast = () => {
    toast({
      title: 'Information',
      description: 'Here is some information for you.',
      status: 'info',
      duration: 5000,
      isClosable: true,
    });
  };

  return (
    <div>
      <Button onClick={showSuccessToast} colorScheme="green" mr={2}>
        Show Success Toast
      </Button>
      <Button onClick={showErrorToast} colorScheme="red" mr={2}>
        Show Error Toast
      </Button>
      <Button onClick={showWarningToast} colorScheme="orange" mr={2}>
        Show Warning Toast
      </Button>
      <Button onClick={showInfoToast} colorScheme="blue">
        Show Info Toast
      </Button>
    </div>
  );
};

export default ToastExample;