import React from 'react';

export const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'success' }> = ({ children, variant = 'primary', className = '', ...props }) => {
  const baseStyle = "px-4 py-2 rounded font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-dark-900 disabled:opacity-50 disabled:cursor-not-allowed";
  
  const variants = {
    primary: "bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-500",
    secondary: "bg-gray-700 hover:bg-gray-600 text-gray-200 focus:ring-gray-500",
    danger: "bg-red-600 hover:bg-red-700 text-white focus:ring-red-500",
    success: "bg-brand-600 hover:bg-brand-700 text-white focus:ring-brand-500"
  };

  return (
    <button className={`${baseStyle} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
};

export const Card: React.FC<{ children: React.ReactNode, title?: string, className?: string, bodyClassName?: string, clip?: boolean }> = ({ children, title, className = '', bodyClassName = '', clip = true }) => (
  <div className={`bg-dark-800 border border-gray-700 rounded-lg shadow-sm ${clip ? 'overflow-hidden' : 'overflow-visible'} ${className}`}>
    {title && <div className="px-4 py-3 border-b border-gray-700 bg-gray-800/50 font-semibold text-gray-200">{title}</div>}
    <div className={`p-4 ${bodyClassName}`}>{children}</div>
  </div>
);

export const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement> & { label?: string }> = ({ label, className = '', ...props }) => (
  <div className="flex flex-col gap-1">
    {label && <label className="text-sm text-gray-400">{label}</label>}
    <input 
      className={`bg-dark-900 border border-gray-700 rounded px-3 py-2 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none ${className}`}
      {...props} 
    />
  </div>
);

export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }> = ({ label, className = '', children, ...props }) => (
  <div className="flex flex-col gap-1">
    {label && <label className="text-sm text-gray-400">{label}</label>}
    <select 
      className={`bg-dark-900 border border-gray-700 rounded px-3 py-2 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none ${className}`}
      {...props} 
    >
      {children}
    </select>
  </div>
);
