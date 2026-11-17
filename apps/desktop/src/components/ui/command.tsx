import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { Search } from "lucide-react"

import { cn } from "@/lib/utils"

/* 命令菜单原语(cmdk):过滤、上下键、回车、listbox/option 无障碍角色都由它管,样式换成产品 token。
   焦点也可以留在外面的输入框里:value 受控 + shouldFilter={false},由输入框自己转发方向键(见 / 命令菜单)。
   高频弹出的菜单不加入场动画(Emil:键盘触发、每天几十次的操作不动)。 */
const Command = React.forwardRef<React.ElementRef<typeof CommandPrimitive>, React.ComponentPropsWithoutRef<typeof CommandPrimitive>>(
  ({ className, ...props }, ref) => <CommandPrimitive ref={ref} className={cn("flex w-full flex-col overflow-hidden text-fg", className)} {...props} />,
)
Command.displayName = CommandPrimitive.displayName

const CommandInput = React.forwardRef<React.ElementRef<typeof CommandPrimitive.Input>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>>(
  ({ className, ...props }, ref) => (
    <div className="flex items-center gap-2 border-b border-line px-3" cmdk-input-wrapper="">
      <Search className="size-4 shrink-0 text-fg-3" />
      <CommandPrimitive.Input ref={ref} className={cn("flex h-10 w-full bg-transparent text-[13.5px] outline-none placeholder:text-fg-3 disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} />
    </div>
  ),
)
CommandInput.displayName = CommandPrimitive.Input.displayName

const CommandList = React.forwardRef<React.ElementRef<typeof CommandPrimitive.List>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>>(
  ({ className, ...props }, ref) => <CommandPrimitive.List ref={ref} className={cn("scroll-thin max-h-[330px] overflow-y-auto overflow-x-hidden", className)} {...props} />,
)
CommandList.displayName = CommandPrimitive.List.displayName

const CommandEmpty = React.forwardRef<React.ElementRef<typeof CommandPrimitive.Empty>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>>(
  ({ className, ...props }, ref) => <CommandPrimitive.Empty ref={ref} className={cn("px-2 py-2 text-[13px] text-fg-2", className)} {...props} />,
)
CommandEmpty.displayName = CommandPrimitive.Empty.displayName

const CommandGroup = React.forwardRef<React.ElementRef<typeof CommandPrimitive.Group>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>>(
  ({ className, ...props }, ref) => (
    <CommandPrimitive.Group ref={ref} className={cn("[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:text-fg-3", className)} {...props} />
  ),
)
CommandGroup.displayName = CommandPrimitive.Group.displayName

const CommandSeparator = React.forwardRef<React.ElementRef<typeof CommandPrimitive.Separator>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>>(
  ({ className, ...props }, ref) => <CommandPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />,
)
CommandSeparator.displayName = CommandPrimitive.Separator.displayName

/** 选中 = data-selected(键盘或指针都会更新);禁用项灰掉、指针不选中 */
const CommandItem = React.forwardRef<React.ElementRef<typeof CommandPrimitive.Item>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>>(
  ({ className, ...props }, ref) => (
    <CommandPrimitive.Item ref={ref} className={cn("relative flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-[7px] text-[13px] outline-none data-[selected=true]:bg-hover data-[disabled=true]:cursor-not-allowed [&_svg]:shrink-0", className)} {...props} />
  ),
)
CommandItem.displayName = CommandPrimitive.Item.displayName

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandSeparator, CommandItem }
