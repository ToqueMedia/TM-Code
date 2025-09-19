import React from 'react';

interface TypeScriptIconProps {
  size?: number;
  color?: string;
}

const TypeScriptIcon: React.FC<TypeScriptIconProps> = ({ 
  size = 16,
  color = '#3178C6'
}) => {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg"
      width={size} 
      height={size} 
      viewBox="0 0 256 256"
      role="img" 
      aria-labelledby="tsTitle tsDesc"
    >
      <title id="tsTitle">Ficheiro TypeScript</title>
      <desc id="tsDesc">Ícone estilo ficheiro com dobra e "TS" no canto inferior direito.</desc>
      
      <style>
        {`
          :root { --ts-blue: ${color}; }
          .bg { fill: var(--ts-blue); }
          .letters { fill: #111111; font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-weight: 900; }
          .fold { fill: #1e5ea8; } /* tom mais escuro para a dobra */
        `}
      </style>
      
      {/* forma do ficheiro com dobra */}
      <path className="bg" d="M48 16h112l48 48v176H48z"/>
      {/* dobra no canto superior direito */}
      <polygon className="fold" points="160,16 208,64 160,64"/>
      
      {/* letras TS deslocadas para o canto inferior direito */}
      <text className="letters" x="185" y="205" fontSize="72" textAnchor="end" dominantBaseline="alphabetic">
        TS
      </text>
    </svg>
  );
};

export default TypeScriptIcon;
