import { forwardRef } from 'react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const Pressable = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'variant' | 'size' | 'shape'>>(({ className, ...props }, ref) => (
  <Button ref={ref} variant={null} size={null} shape={null} className={cn('justify-start text-left font-normal', className)} {...props} />
))
Pressable.displayName = 'Pressable'

export const TextLink = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'variant' | 'size' | 'shape'>>(({ className, ...props }, ref) => (
  <Button ref={ref} variant="link" size={null} shape={null} className={cn('font-normal', className)} {...props} />
))
TextLink.displayName = 'TextLink'
