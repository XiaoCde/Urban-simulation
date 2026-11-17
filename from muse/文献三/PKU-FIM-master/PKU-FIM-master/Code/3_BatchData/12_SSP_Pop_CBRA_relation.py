# -*-coding:utf-8 -*-
# python 3.9
# current的pop和CBRA关系算出来，然后用于SSP pop预测SSP的CBRA
# 生成新的model_input

"""
# @File       : 12_SSP_Pop_CBRA_relation.py
# @software   : PyCharm  
# @Time       ：2025/5/16 21:36
# @Author     ：Wei Lyu
"""

import pandas as pd
import statsmodels.api as sm
import numpy as np
import os

path = r'D:\LW\ABM'

cities = pd.read_csv(path + r'\OutputData\cities_21\cities21_pop_CH.csv', header=None, encoding='gbk')
cities_ch = cities[0].tolist()
cities_en = cities[3].tolist()
del cities

for i in range(len(cities_ch)):
    city_cn = cities_ch[i]
    city_en = cities_en[i]

    # 关联上hazard和pop
    df_hazard = pd.read_csv(path + r'\OutputData\Result_SSP585_pop2\cities_21_max\\' + city_cn + r'\grid_hazard.csv', header=0)
    df_hazard['Tid'] += 1

    df_pop = pd.read_csv(path + r'\OutputData\Result_SSP585_pop2\cities_21_max\\' + city_cn + r'\grid_population.csv', header=0)
    df_pop['Tid'] += 1

    df = pd.read_csv(path + r'\OutputData\Result\cities_21_max\\' + city_cn + r'\model_input.csv', header=0)

    # OLS slope model
    X = df['Con_pop']
    Y = df['CBRA']
    X = sm.add_constant(X)
    model = sm.OLS(Y, X).fit()
    coef = model.params

    df_new = df[['FID', 'Tid']].copy()
    df_new = pd.merge(df_new, df_hazard, on='Tid', how='left')
    df_new['Hazard'] = df_new['Hazard'].fillna(0)

    df_new = pd.merge(df_new, df_pop, on='Tid', how='left')
    df_new['Con_pop'] = df_new['Con_pop'].fillna(0)
    del df_hazard, df_pop

    df_new['CBRA'] = df_new['Con_pop'] * coef[0] + coef[1]
    df_new['CBRA'] = df_new['CBRA'].fillna(0) 
    df_new['CBRA'] = np.maximum(df['CBRA'], df_new['CBRA'])

    df_new['County'] = df['County']
    df_new['County'].astype(int)
    del df

    df_new.to_csv(path + r'\OutputData\Result_SSP585_pop2\cities_21_max\\' + city_cn + '\\' + 'model_input.csv', header=True, index=False)







