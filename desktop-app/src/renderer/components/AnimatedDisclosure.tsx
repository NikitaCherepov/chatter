import { useLayoutEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

export function AnimatedCollapse({open,children}:{open:boolean;children:ReactNode}) {
 const reduced=useReducedMotion();
 return <AnimatePresence initial={false}>{open&&<motion.div
  initial={{height:0,opacity:0}} animate={{height:'auto',opacity:1}} exit={{height:0,opacity:0}}
  transition={{duration:reduced?0:.2,ease:[.22,1,.36,1]}} style={{overflow:'hidden'}}
 >{children}</motion.div>}</AnimatePresence>;
}

/** Keep native details open until the closing animation has actually finished. */
export function AnimatedDetails({children,summary,className,open:controlled,onOpenChange,locked=false}: {
 children:ReactNode;summary:ReactNode;className?:string;open?:boolean;onOpenChange?:(open:boolean)=>void;locked?:boolean;
}) {
 const reduced=useReducedMotion();
 const [local,setLocal]=useState(false);
 const expanded=controlled??local;
 const [visible,setVisible]=useState(expanded);
 useLayoutEffect(()=>{if(expanded)setVisible(true);},[expanded]);
 return <details className={className} open={expanded||visible} data-expanded={expanded}>
  <summary aria-expanded={expanded} onClick={event=>{
   event.preventDefault();if(locked)return;
   if(controlled===undefined)setLocal(!expanded);
   onOpenChange?.(!expanded);
  }}>{summary}</summary>
  <motion.div initial={false} animate={{height:expanded?'auto':0,opacity:expanded?1:0}}
   transition={{duration:reduced?0:.2,ease:[.22,1,.36,1]}} style={{overflow:'hidden'}}
   onAnimationComplete={()=>{if(!expanded)setVisible(false);}}
  >{children}</motion.div>
 </details>;
}
