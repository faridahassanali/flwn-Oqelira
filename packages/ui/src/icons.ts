import {
  createElement, MessageSquare, ListTodo, FolderOpen, SquareTerminal, GitBranch,
  Settings, PanelsTopLeft, Brain, Plus, ArrowUpRight, ArrowUp, Square,
  ChevronDown, X, Check, Circle, LoaderCircle, Ellipsis, PanelRight,
  LogOut, Copy, FileText, RefreshCw, ArrowLeft, ShieldCheck, Sparkles, Users,
} from 'lucide'

const icons = {
  Chat: MessageSquare, Tasks: ListTodo, Explorer: FolderOpen, Terminal: SquareTerminal,
  Git: GitBranch, Settings, Projects: PanelsTopLeft, Memory: Brain, Teams:Users, Plus,
  ArrowUpRight, Send: ArrowUp, Stop: Square, ChevronDown, Close: X, Check,
  Circle, LoaderCircle, More: Ellipsis, PanelRight, LogOut, Copy, FileText,
  Refresh: RefreshCw, Back: ArrowLeft, ShieldCheck, Sparkles,
}
export type IconName = keyof typeof icons
export function icon(name: IconName, className = ''): string {
  return createElement(icons[name], {
    class: `icon ${className}`.trim(), 'aria-hidden': 'true', focusable: 'false',
    'stroke-width': 2,
  }).outerHTML
}
