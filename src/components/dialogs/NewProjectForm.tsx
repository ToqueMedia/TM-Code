import React from 'react'
import {
  Button,
  Field,
  Input,
  Portal,
  Select,
} from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { ProjectTemplate } from '../../types/project'
import { templateCollection } from './useNewProjectDialog'

interface NewProjectFormProps {
  projectName: string
  onProjectNameChange: (value: string) => void
  template: ProjectTemplate
  onTemplateChange: (value: ProjectTemplate) => void
  location: string
  onLocationChange: (value: string) => void
  onBrowse: () => void
  error: string
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

const focusStyle = {
  borderColor: tokens.colors.accent.primary,
  boxShadow: 'none',
}

export function NewProjectForm({
  projectName,
  onProjectNameChange,
  template,
  onTemplateChange,
  location,
  onLocationChange,
  onBrowse,
  error,
  fileInputRef,
  onFileInputChange,
}: NewProjectFormProps) {
  return (
    <>
      <Field.Root>
        <Field.Label
          color="text.primary"
          fontWeight="600"
          fontSize={tokens.fontSize.lg}
        >
          {t('newProject.projectName')}
        </Field.Label>
        <Input
          value={projectName}
          onChange={(e) => onProjectNameChange(e.target.value)}
          placeholder="my-awesome-project"
          bg="bg.glass"
          color="text.primary"
          border="1px solid"
          borderColor="border.default"
          _focus={focusStyle}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </Field.Root>

      <Field.Root mt={4}>
        <Field.Label
          color="text.primary"
          fontWeight="600"
          fontSize={tokens.fontSize.lg}
        >
          {t('newProject.template')}
        </Field.Label>
        <Select.Root
          collection={templateCollection}
          value={[template]}
          onValueChange={(e) => onTemplateChange(e.value[0] as ProjectTemplate)}
        >
          <Select.Control
            bg="bg.glass"
            border="1px solid"
            borderColor="border.default"
            _focus={focusStyle}
          >
            <Select.Trigger>
              <Select.ValueText color="text.primary" />
            </Select.Trigger>
            <Select.Indicator />
          </Select.Control>
          <Portal>
            <Select.Positioner>
              <Select.Content
                bg="bg.editor"
                color="text.primary"
                border="1px solid"
                borderColor="border.default"
              >
                {templateCollection.items.map((item) => (
                  <Select.Item
                    key={item.value}
                    item={item}
                    bg="bg.editor"
                    color="text.primary"
                    _hover={{
                      bg: tokens.colors.accent.primarySubtle,
                    }}
                    _selected={{
                      bg: tokens.colors.accent.primary,
                      color: tokens.colors.text.inverse,
                    }}
                  >
                    {item.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Portal>
        </Select.Root>
      </Field.Root>

      <Field.Root mt={4}>
        <Field.Label
          color="text.primary"
          fontWeight="600"
          fontSize={tokens.fontSize.lg}
        >
          Location
        </Field.Label>
        <Input
          value={location}
          onChange={(e) => onLocationChange(e.target.value)}
          placeholder="~/Projects"
          mb={2}
          bg="bg.glass"
          color="text.primary"
          border="1px solid"
          borderColor="border.default"
          _focus={focusStyle}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={onBrowse}
          color="text.primary"
          borderColor="border.default"
          _hover={{
            bg: tokens.colors.accent.primarySubtle,
            borderColor: tokens.colors.accent.primary,
          }}
        >
          Browse
        </Button>
      </Field.Root>

      {/* Hidden file input for web fallback */}
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={onFileInputChange}
        {...({ directory: '', webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
      />

      {error && (
        <Field.Root>
          <Field.ErrorText
            color={tokens.colors.accent.red}
            mt={2}
            fontSize={tokens.fontSize.md}
          >
            {error}
          </Field.ErrorText>
        </Field.Root>
      )}
    </>
  )
}
