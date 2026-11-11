import { forwardRef } from 'react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/* 外形由内容决定的可点区域(卡片、整行、气泡里的小标签、居中的灰字行):
   沿用 Button 原语的 type=button、焦点环、按下 scale(.97)、只过渡颜色/阴影/transform,不带尺寸、底色和圆角档位。
   建议上提为 Button 的 variant="bare"(回报里写了)。 */
export const Pressable = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'variant' | 'size' | 'shape'>>(({ className, ...props }, ref) => (
  <Button ref={ref} variant={null} size={null} shape={null} className={cn('justify-start text-left font-normal', className)} {...props} />
))
Pressable.displayName = 'Pressable'

/** 文字链(恢复、重新编辑、原消息…):Button 的 link 变体,不带尺寸档(size 档会把 link 的 h-auto px-0 覆盖掉) */
export const TextLink = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'variant' | 'size' | 'shape'>>(({ className, ...props }, ref) => (
  <Button ref={ref} variant="link" size={null} shape={null} className={cn('font-normal', className)} {...props} />
))
TextLink.displayName = 'TextLink'
